/**
 * `RemoteAccessService` – the sharing side of "Several computers" (docs/wp/WP-75.md §4.2,
 * WP-76 §B.6–B.11): checks, listener, pairing window, the one coupling, connection log and the
 * `remoteAccess.*` commands. `HostState.remoteAccess` comes from `state()`; the pairing code only
 * travels in the ack of `remoteAccess.pair` (never in the state, never logged).
 *
 * Coupling generation (§B.8): a number in memory, raised by every change of the coupling (pairing,
 * unpair, renewed key) and by stopping the listener. Peer sockets and hub connections carry the
 * generation of their set-up; `isCurrentConnection()` is the check before every effect.
 *
 * Mutating operations (activate, deactivate, unpair, renew, check, pairing commit) run one after the
 * other.
 */
import type { Logger } from 'pino';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { MultiHostConfig, MultiHostRole, RemoteAccessCheck, RemoteAccessState } from '@shared/model';
import { WS_CLOSE, type HostCommand, type HostCommandName } from '@shared/protocol';
import type { ServerInstance } from '../config';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { createIdentityStore, type FileIdentityStore } from '../secure/identityStore';
import { KeyStoreError, type Identity, type KeyStore } from '../secure/ports';
import { tlsSelfTest, type SelfTestFailure } from '../secure/selfTest';
import { SECRET_BYTES } from '../secure/tlsProfile';
import type { StoreWarningSink } from '../store/jsonStore';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import { computerName, detectIpv4Addresses, listenerAddresses } from './addresses';
import { runRemoteChecks, type PortProbe } from './checks';
import { createRemoteEventLog, type FileRemoteEventLog } from './eventLog';
import { checkFirewall, type FirewallState } from './firewall';
import { GuardedHubSocket } from './hubSocket';
import { REMOTE_LIMITS, type RemoteLimits } from './limits';
import { RemoteListenError, RemoteListener, type RemoteSocketInfo } from './listener';
import { PairingResponder, type PairingCommit } from './pairing';
import { createPairingHttp } from './pairingHttp';
import { PairingWindow, type PairingWindowCloseReason } from './pairingWindow';
import { createPeerHttp, type PeerHttp, type RegisterRemoteContent } from './peerHttp';
import { createPeerStore, type FilePeerStore } from './peerStore';
import type { RemoteAccessService, RemoteEventInput, RemoteHubAttach } from './ports';

/** Key store purpose of kAuth on the sharing computer (`remotePeerRecordSchema.authKey`). */
export const PEER_AUTH_PURPOSE = 'auth:peer';

export const REMOTE_ACCESS_COMMANDS = [
  'remoteAccess.pair',
  'remoteAccess.cancelPairing',
  'remoteAccess.unpair',
  'remoteAccess.renewKey',
  'remoteAccess.check',
  'remoteAccess.events',
  'remoteAccess.eventsSeen',
] as const satisfies readonly HostCommandName[];

export interface RemoteAccessServiceOptions {
  home: string;
  instance: ServerInstance;
  hub: RemoteHubAttach;
  keyStore: KeyStore;
  /** WP-78b: blob/file/attachments on the peer app (`src/server/http/content.ts`). */
  registerContent?: RegisterRemoteContent;
  /** The role for REMOTE_ROLE_CONFLICT {role} while this side is inactive (default `off`). */
  currentRole?: () => MultiHostRole;
  warnings?: StoreWarningSink;
  identityStore?: FileIdentityStore;
  peerStore?: FilePeerStore;
  eventLog?: FileRemoteEventLog;
  limits?: RemoteLimits;
  now?: () => Date;
  logger?: Logger;
  hostName?: () => string;
  detectAddresses?: () => string[];
  firewall?: () => Promise<FirewallState>;
  selfTest?: () => Promise<SelfTestFailure | null>;
  probePort?: (address: string, port: number) => Promise<PortProbe>;
  pairingWindowMs?: number;
}

export interface RemoteAccess extends RemoteAccessService {
  /** Reads `remote/peer.json` and the log so that `couplings()` is right before activation; idempotent. */
  prepare(): Promise<void>;
  /**
   * Still a connection of the CURRENT coupling? For the hub (a `HubSocket` handed over by this
   * service) and the content routes (the request socket) – check before every effect (§B.8).
   */
  isCurrentConnection(socket: object): boolean;
  /** Deactivates, flushes the stores and closes the peer HTTP app (server shutdown, tests). */
  close(): Promise<void>;
  /** Open sockets by class (diagnostics and tests; no addresses, no secrets). */
  connectionCounts(): { pairing: number; peer: number };
}

interface PeerSecret {
  pin: string;
  authKey: Buffer;
}

function sameListen(a: MultiHostConfig | null, b: MultiHostConfig): boolean {
  return a !== null && a.port === b.port && a.bindAddress === b.bindAddress;
}

function isStoreError(error: ErrorPayload | null): boolean {
  return error?.code === 'REMOTE_ACCESS_FAILED' && error.params.reason === 'store';
}

export function createRemoteAccessService(options: RemoteAccessServiceOptions): RemoteAccess {
  const now = options.now ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ module: 'remoteAccess' });
  const limits = options.limits ?? REMOTE_LIMITS;
  const hostName = options.hostName ?? (() => computerName());
  const detect = options.detectAddresses ?? (() => detectIpv4Addresses());
  const currentRole = options.currentRole ?? ((): MultiHostRole => 'off');
  const { hub, keyStore, instance } = options;
  const storeOptions = {
    home: options.home,
    logger: options.logger ?? rootLogger,
    ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
  };
  const identityStore = options.identityStore ?? createIdentityStore({ ...storeOptions, keyStore });
  const peerStore = options.peerStore ?? createPeerStore(storeOptions);
  const eventLog = options.eventLog ?? createRemoteEventLog(storeOptions);

  let active: MultiHostConfig | null = null;
  let error: ErrorPayload | null = null;
  let checks: RemoteAccessCheck[] = [];
  let addresses: string[] = [];
  let identity: Identity | null = null;
  let generation = 1;
  let secret: PeerSecret | null = null;
  let peerLive: { appVersion: string | null; compatible: boolean } = { appVersion: null, compatible: true };
  let websockets = 0;
  let peerCount = 0;
  let prepareError: unknown = null;
  let peerHttp: PeerHttp | null = null;
  let lastState = 'null';
  const listeners = new Set<() => void>();

  // ---- helpers ----

  const emitChange = (): void => {
    const next = JSON.stringify(service.state());
    if (next === lastState) return;
    lastState = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (failure) {
        log.error({ err: failure }, 'remote access listener failed');
      }
    }
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const record = (event: RemoteEventInput): void => {
    if (active === null) return;
    eventLog.record(event, now());
  };

  const wipeSecret = (): void => {
    secret?.authKey.fill(0);
    secret = null;
  };

  /** Records `payload` as the listener error and returns the CommandError to throw. */
  const failWith = (payload: ErrorPayload): CommandError => {
    error = payload;
    emitChange();
    return new CommandError(payload);
  };

  const window = new PairingWindow({
    now,
    ...(options.pairingWindowMs === undefined ? {} : { windowMs: options.pairingWindowMs }),
    onClose: (_id: string, reason: PairingWindowCloseReason) => {
      // used / failures / lapsed: the responder ends the other sockets itself (its own one still answers).
      if (reason !== 'used' && reason !== 'failures' && reason !== 'lapsed') listener.destroyPairingSockets();
      emitChange();
    },
  });

  const listener: RemoteListener = new RemoteListener({
    limits,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    hooks: {
      coupling: () => {
        const peer = peerStore.get();
        const current = secret;
        if (peer === null || current?.pin !== peer.pin) return null;
        return { pin: peer.pin, generation, authKey: current.authKey };
      },
      generation: () => generation,
      isRevoked: (pin) => peerStore.isRevoked(pin),
      pairingWindowId: () => {
        const open = window.current();
        return open !== null && !window.isExpired(open.id) ? open.id : null;
      },
      record,
      onPeer: (socket) => {
        if (peerHttp === null) socket.destroy();
        else peerHttp.emit(socket);
      },
      onPairing: (socket) => {
        pairingHttp.emit(socket);
      },
      onPeerCount: (count, info: RemoteSocketInfo) => {
        const name = peerStore.get()?.name ?? null;
        if (peerCount === 0 && count > 0)
          record({ kind: 'connected', address: info.address, port: info.port, claimedName: name });
        if (peerCount > 0 && count === 0) {
          record({ kind: 'disconnected', address: info.address, port: info.port, claimedName: name });
        }
        peerCount = count;
        emitChange();
      },
    },
  });

  const commitPeer = (input: PairingCommit): Promise<void> =>
    serial(async () => {
      if (active === null || !listener.listening)
        throw new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'listen' }));
      let authKey: Buffer;
      try {
        authKey = await keyStore.protect(PEER_AUTH_PURPOSE, input.kAuth);
      } catch {
        throw new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
      }
      const replacing = peerStore.get();
      try {
        await peerStore.set({
          name: input.name,
          pin: input.pin,
          certificate: input.certificateDer.toString('base64'),
          authKey: authKey.toString('base64'),
          pairedAt: now().toISOString(),
          lastSeenAt: null,
          lastAddress: input.address,
        });
      } catch (failure) {
        log.error({ err: failure }, 'peer not stored');
        throw new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
      }
      // The new coupling is in force: new generation, the old one's connections end (§B.8).
      generation += 1;
      if (replacing !== null) {
        hub.closeRemote(WS_CLOSE.HOST_REVOKED);
        listener.destroyPeerSockets();
      }
      wipeSecret();
      secret = { pin: input.pin, authKey: Buffer.from(input.kAuth) };
      peerLive = { appVersion: null, compatible: true };
      emitChange();
    });

  const responder = new PairingResponder({
    window,
    instance,
    hostName,
    limits,
    socketInfo: (socket) => listener.info(socket),
    commit: commitPeer,
    record,
    destroyPairingSockets: (except) => {
      listener.destroyPairingSockets(except);
    },
    now: () => now().getTime(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const pairingHttp = createPairingHttp({
    limits,
    hooks: {
      pair: (socket, body, headers) => responder.respond(socket, body, headers),
      onRejected: (socket, kind) => {
        const info = listener.info(socket);
        record({ kind, address: info?.address ?? 'unknown', port: info?.port ?? null });
      },
    },
  });

  const ensurePeerHttp = async (): Promise<PeerHttp> => {
    peerHttp ??= await createPeerHttp({
      instance,
      hostName,
      ...(options.registerContent === undefined ? {} : { registerContent: options.registerContent }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      hooks: {
        hub,
        isCurrent: (socket) => listener.isCurrentPeer(socket),
        connectionInfo: (socket) => {
          const info = listener.info(socket);
          return { address: info?.address ?? 'unknown', port: info?.port ?? null };
        },
        onVersion: (socket, appVersion, compatible) => {
          const info = listener.info(socket);
          if (compatible && info !== undefined) peerStore.touch(info.address, now());
          peerLive = { appVersion, compatible };
          emitChange();
        },
        onRejected: (socket, kind) => {
          const info = listener.info(socket);
          record({
            kind,
            address: info?.address ?? 'unknown',
            port: info?.port ?? null,
            claimedName: peerStore.get()?.name ?? null,
          });
        },
        unpairSelf: (socket) =>
          serial(async () => {
            if (!listener.isCurrentPeer(socket)) return;
            const info = listener.info(socket);
            await unpairNow(socket, info?.address ?? 'unknown', info?.port ?? null);
          }),
        onWebSocket: (delta) => {
          websockets = Math.max(0, websockets + delta);
          emitChange();
        },
      },
    });
    return peerHttp;
  };

  const loadSecret = async (): Promise<void> => {
    const peer = peerStore.get();
    if (peer === null) {
      wipeSecret();
      return;
    }
    if (secret?.pin === peer.pin) return;
    const plain = await keyStore.unprotect(PEER_AUTH_PURPOSE, Buffer.from(peer.authKey, 'base64'));
    if (plain.length !== SECRET_BYTES) {
      plain.fill(0);
      throw new KeyStoreError('failed');
    }
    wipeSecret();
    secret = { pin: peer.pin, authKey: plain };
  };

  const stopListener = async (): Promise<void> => {
    generation += 1;
    window.close('stopped');
    hub.closeRemote(WS_CLOSE.SERVER_SHUTDOWN);
    await listener.stop();
    peerCount = 0;
  };

  /** Loads what the listener needs and starts it; sets `error` and throws CommandError on failure. */
  const startListening = async (config: MultiHostConfig): Promise<void> => {
    const key = identity;
    if (key === null) throw failWith(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
    try {
      await loadSecret();
    } catch {
      throw failWith(makeError('REMOTE_KEYSTORE_UNAVAILABLE'));
    }
    if (peerStore.writeFailed) {
      try {
        await peerStore.flush();
      } catch {
        throw failWith(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
      }
    }
    await ensurePeerHttp();
    try {
      await listener.start(key, config.bindAddress, config.port);
    } catch (failure) {
      throw failWith(
        makeError('REMOTE_ACCESS_FAILED', {
          reason: failure instanceof RemoteListenError ? failure.reason : 'listen',
        }),
      );
    }
    error = null;
    emitChange();
  };

  const runChecks = async (config: MultiHostConfig): Promise<ErrorPayload | null> => {
    const own = listener.address();
    const result = await runRemoteChecks({
      bindAddress: config.bindAddress,
      port: config.port,
      ownListener: own !== null && sameListen(active, config),
      keyStore,
      identity: async () =>
        (await identityStore.load('identity')) ?? (await identityStore.create('identity')),
      selfTest: options.selfTest ?? (() => tlsSelfTest()),
      addresses: () => listenerAddresses(config.bindAddress, detect),
      firewall: options.firewall ?? (() => checkFirewall()),
      ...(options.probePort === undefined ? {} : { probe: options.probePort }),
    });
    checks = result.checks;
    addresses = listenerAddresses(config.bindAddress, detect);
    if (result.identity !== null) identity = result.identity;
    return result.error;
  };

  /** Unpair in the order of §B.8; `except` = the socket that still answers (DELETE peer/self). */
  const unpairNow = async (except: object | null, address: string, port: number | null): Promise<void> => {
    const peer = peerStore.get();
    if (peer === null && !peerStore.writeFailed) return;
    // 1. memory: coupling gone, new generation, every connection of it ends at once
    generation += 1;
    hub.closeRemote(WS_CLOSE.HOST_REVOKED);
    listener.destroyPeerSockets(except ?? undefined);
    wipeSecret();
    peerLive = { appVersion: null, compatible: true };
    if (peer !== null) record({ kind: 'unpaired', address, port, claimedName: peer.name });
    // 2. then the file (clear() changed the memory synchronously)
    const written = peerStore.clear();
    emitChange();
    try {
      await written;
    } catch (failure) {
      // 3. the revoked pin would come back after a restart → the listener stays off until a write succeeds
      log.error({ err: failure }, 'unpair not stored – remote access stopped');
      await stopListener();
      throw failWith(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
    }
    if (active !== null && !listener.listening && isStoreError(error)) await startListening(active);
    emitChange();
  };

  const requireActive = (): MultiHostConfig => {
    if (active === null) throw new CommandError(makeError('REMOTE_ROLE_CONFLICT', { role: currentRole() }));
    return active;
  };

  const handle = async (cmd: HostCommand): Promise<unknown> => {
    const config = requireActive();
    switch (cmd.name) {
      case 'remoteAccess.pair': {
        const bound = listener.address();
        if (bound === null)
          throw new CommandError(error ?? makeError('REMOTE_ACCESS_FAILED', { reason: 'listen' }));
        const opened = window.open();
        emitChange();
        return {
          code: opened.code,
          expiresAt: opened.expiresAt.toISOString(),
          hostName: hostName(),
          addresses,
          port: bound.port,
        };
      }
      case 'remoteAccess.cancelPairing':
        window.close('cancelled');
        return {};
      case 'remoteAccess.unpair':
        await serial(() => unpairNow(null, 'local', null));
        return {};
      case 'remoteAccess.renewKey':
        await serial(async () => {
          window.close('cancelled');
          await unpairNow(null, 'local', null);
          let renewed: Identity;
          try {
            renewed = await identityStore.create('identity');
          } catch (failure) {
            throw failWith(
              failure instanceof KeyStoreError
                ? makeError('REMOTE_KEYSTORE_UNAVAILABLE')
                : makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }),
            );
          }
          identity = renewed;
          listener.setIdentity(renewed);
          log.info('identity key renewed');
          emitChange();
        });
        return {};
      case 'remoteAccess.check':
        return serial(async () => {
          const blocking = await runChecks(config);
          if (!listener.listening && active !== null) {
            if (blocking === null) await startListening(active).catch(() => undefined);
            else error = blocking;
          }
          emitChange();
          return { checks };
        });
      case 'remoteAccess.events':
        return { events: eventLog.list(cmd.onlyRejected) };
      case 'remoteAccess.eventsSeen':
        eventLog.markSeen(now());
        emitChange();
        return {};
      default:
        throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
    }
  };

  const commands: HostCommandHandler = {
    names: REMOTE_ACCESS_COMMANDS,
    handle: (cmd) => handle(cmd),
  };

  eventLog.onChange(emitChange);

  const service: RemoteAccess = {
    role: 'share',
    commands,
    couplings: () => {
      if (prepareError !== null) return 1;
      return peerStore.get() === null ? 0 : 1;
    },
    async prepare() {
      try {
        await peerStore.load();
        prepareError = null;
      } catch (failure) {
        prepareError = failure;
        log.error({ err: failure }, 'peer file could not be read');
      }
      await eventLog.load();
    },
    activate: (config) =>
      serial(async () => {
        const previous = active;
        active = config;
        if (listener.listening && sameListen(previous, config) && error === null) {
          emitChange();
          return;
        }
        if (listener.listening) await stopListener();
        await service.prepare();
        if (prepareError !== null) throw failWith(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
        const blocking = await runChecks(config);
        if (blocking !== null) throw failWith(blocking);
        await startListening(config);
      }),
    deactivate: () =>
      serial(async () => {
        if (active === null) return;
        active = null;
        await stopListener();
        wipeSecret();
        error = null;
        checks = [];
        websockets = 0;
        peerLive = { appVersion: null, compatible: true };
        await Promise.all([
          peerStore.flush().catch((failure: unknown) => {
            log.warn({ err: toError(failure) }, 'peer file not flushed');
          }),
          eventLog.flush(),
        ]);
        emitChange();
      }),
    state() {
      if (active === null) return null;
      const peer = peerStore.get();
      const bound = listener.address();
      const state: RemoteAccessState = {
        listening: bound !== null,
        port: bound?.port ?? (active.port > 0 ? active.port : null),
        addresses,
        hostName: hostName(),
        checks,
        peer:
          peer === null
            ? null
            : {
                name: peer.name,
                pairedAt: peer.pairedAt,
                connected: listener.peerCount() > 0,
                connections: websockets,
                lastSeenAt: peer.lastSeenAt,
                lastAddress: peer.lastAddress,
                appVersion: peerLive.appVersion,
                compatible: peerLive.compatible,
              },
        pairingExpiresAt: window.expiresAt()?.toISOString() ?? null,
        unseenRejected: eventLog.unseenRejected(),
        error,
      };
      return state;
    },
    onChange(listenerFn) {
      listeners.add(listenerFn);
      return () => {
        listeners.delete(listenerFn);
      };
    },
    connectionCounts: () => ({ pairing: listener.pairingCount(), peer: listener.peerCount() }),
    isCurrentConnection(socket) {
      if (socket instanceof GuardedHubSocket) return socket.isCurrent();
      return listener.isCurrentPeer(socket);
    },
    async close() {
      await service.deactivate();
      await peerHttp?.close();
      peerHttp = null;
      await eventLog.close();
    },
  };
  return service;
}
