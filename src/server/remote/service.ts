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
 *
 * WP-107 (docs/wp/WP-76.md §B.13):
 * - Level of the coupling: chosen on site with the pairing window (`remoteAccess.pair {level}` from a
 *   local window or `parallax remote pair --level manage`), written into the peer on success.
 *   `remoteAccess.setPeerLevel`: locally either way, over remote access only `manage` → `control`;
 *   every change raises the generation and ends every peer socket (the windows reconnect with the new
 *   level). Raising: a failed write keeps `control`. Lowering: a failed write unpairs (fail closed).
 * - Connection log: `level_changed` (detail `control>manage`, the contract's form), `manage_command` (the command name),
 *   `terminal_opened`.
 * - Terminal through the relay (E3): `attachTerminal` (the composition hands the terminal service in
 *   after it exists); upgrades on REMOTE_PATHS.terminalWs open terminals "through remote access".
 *   Unpairing, a replaced coupling, a renewed key, a level change, "Share off" and a role change end
 *   them (`TerminalService.closeRemote`); local terminals stay.
 */
import type { Logger } from 'pino';
import { makeError, type ErrorPayload } from '@shared/errors';
import type {
  MultiHostConfig,
  MultiHostRole,
  RemoteAccessCheck,
  RemoteAccessState,
  RemotePeerLevel,
} from '@shared/model';
import {
  REMOTE_MANAGE_COMMANDS,
  WS_CLOSE,
  type CommandName,
  type HostCommand,
  type HostCommandName,
} from '@shared/protocol';
import type { ServerInstance } from '../config';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { createIdentityStore, type FileIdentityStore } from '../secure/identityStore';
import { KeyStoreError, type Identity, type KeyStore } from '../secure/ports';
import { tlsSelfTest, type SelfTestFailure } from '../secure/selfTest';
import { SECRET_BYTES } from '../secure/tlsProfile';
import type { StoreWarningSink } from '../store/jsonStore';
import { CommandError, type CommandContext, type HostCommandHandler } from '../sync/ports';
import type { TerminalService } from '../terminal/ports';
import { computerName, detectIpv4Addresses, listenerAddresses } from './addresses';
import { runRemoteChecks, type PortProbe } from './checks';
import { createRemoteEventLog, type FileRemoteEventLog, type RemoteEventRecord } from './eventLog';
import { GuardedHubSocket } from './hubSocket';
import { REMOTE_LIMITS, type RemoteLimits } from './limits';
import { RemoteListenError, RemoteListener, type RemoteSocketInfo } from './listener';
import { PairingResponder, type PairingCommit } from './pairing';
import { createPairingHttp } from './pairingHttp';
import { PairingWindow, type PairingWindowCloseReason } from './pairingWindow';
import { createPeerHttp, type PeerHttp, type RegisterRemoteContent } from './peerHttp';
import { createPeerStore, type FilePeerStore } from './peerStore';
import { createPeerTerminalBridge, type PeerTerminalBridge } from './peerTerminal';
import type { RemoteAccessService, RemoteHubAttach } from './ports';

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
  'remoteAccess.setPeerLevel',
] as const satisfies readonly HostCommandName[];

const MANAGE_COMMANDS: ReadonlySet<string> = new Set(REMOTE_MANAGE_COMMANDS);

/** `level_changed` detail (`control>manage`, remoteEventSchema). */
export function levelChangeDetail(from: RemotePeerLevel, to: RemotePeerLevel): string {
  return `${from}>${to}`;
}

/** The pairing code is only for a local window or the local command line (§B.2 no. 7). */
function isLocal(ctx: CommandContext | undefined): boolean {
  return (ctx?.access ?? 'local') === 'local';
}

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
  selfTest?: () => Promise<SelfTestFailure | null>;
  probePort?: (address: string, port: number) => Promise<PortProbe>;
  pairingWindowMs?: number;
  /** WP-107: the terminal service (or later via `attachTerminal`). */
  terminal?: TerminalService;
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
  /**
   * WP-107 (E3): the embedded terminal for the coupled computer – the composition calls it once the
   * terminal service exists (until then a terminal upgrade is refused with 404).
   */
  attachTerminal(service: TerminalService): void;
  /** Open terminal sockets of the coupled computer (diagnostics and tests). */
  terminalConnections(): number;
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
  let terminalService: TerminalService | null = options.terminal ?? null;
  let terminalBridge: Promise<PeerTerminalBridge> | null = null;
  let bridgeReady: PeerTerminalBridge | null = null;
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

  const record = (event: RemoteEventRecord): void => {
    if (active === null) return;
    eventLog.record(event, now());
  };

  /** Ends every terminal started through remote access (§B.13 lifecycle); local ones stay. */
  const closeRemoteTerminals = (): void => {
    try {
      terminalService?.closeRemote();
    } catch (failure) {
      log.error({ err: failure }, 'remote terminals not closed');
    }
  };

  /** The address the coupled computer was last seen at (log rows of its actions). */
  const peerAddress = (socket: object | null): { address: string; port: number | null } => {
    const info = socket === null ? undefined : listener.info(socket);
    if (info !== undefined) return { address: info.address, port: info.port };
    return { address: peerStore.get()?.lastAddress ?? 'unknown', port: null };
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
          // WP-107: the level chosen on site with the window (§B.13).
          level: input.level,
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
        closeRemoteTerminals();
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
      firstRequestMs: limits.peerFirstRequestMs,
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
        level: () => peerStore.get()?.level ?? 'control',
        onCommand: (socket, command) => {
          onPeerCommand(socket, command);
        },
        onTerminal: (ws, current) => {
          const service = terminalService;
          if (service === null) return false;
          terminalBridge ??= createPeerTerminalBridge({
            service,
            onOpen: () => {
              record({
                kind: 'terminal_opened',
                ...peerAddress(null),
                claimedName: peerStore.get()?.name ?? null,
              });
            },
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          });
          // The first `hello` may arrive before the bridge exists: hold the frames until it does.
          ws.pause();
          terminalBridge.then(
            (bridge) => {
              bridgeReady = bridge;
              if (!current()) {
                ws.terminate();
                return;
              }
              bridge.handle(ws, current);
              ws.resume();
            },
            (failure: unknown) => {
              log.error({ err: failure }, 'terminal bridge not created');
              ws.terminate();
            },
          );
          return true;
        },
      },
    });
    return peerHttp;
  };

  /** A window of the coupled computer runs `command` (connection log; name only, §B.13). */
  const onPeerCommand = (socket: object, command: CommandName): void => {
    const name = peerStore.get()?.name ?? null;
    if (MANAGE_COMMANDS.has(command)) {
      record({ kind: 'manage_command', ...peerAddress(socket), claimedName: name, detail: command });
    } else if (command === 'session.openInTerminal') {
      record({ kind: 'terminal_opened', ...peerAddress(socket), claimedName: name });
    }
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
    // "Share off", a role change, a new listen address: no shell keeps running for the other side.
    closeRemoteTerminals();
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
    // Fail closed (security review): only a data folder that takes writes may listen – after a
    // failed revocation and a restart the old coupling would otherwise be back without a word.
    try {
      await peerStore.persist();
    } catch {
      throw failWith(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
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
    closeRemoteTerminals();
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

  /**
   * `remoteAccess.setPeerLevel` (§B.13): locally either way; over remote access only `manage` →
   * `control`. A change raises the generation and ends every peer socket and remote terminal.
   */
  const setPeerLevel = (level: RemotePeerLevel, ctx: CommandContext | undefined): Promise<void> =>
    serial(async () => {
      const peer = peerStore.get();
      if (peer === null) throw new CommandError(makeError('VALIDATION_FAILED', { reason: 'not_paired' }));
      if (peer.level === level) return;
      const local = isLocal(ctx);
      if (!local && !(ctx?.access === 'manage' && peer.level === 'manage' && level === 'control')) {
        throw new CommandError(makeError('REMOTE_NOT_ALLOWED', { command: 'remoteAccess.setPeerLevel' }));
      }
      const who = local ? { address: 'local', port: null } : peerAddress(null);
      try {
        await peerStore.set({ ...peer, level });
      } catch (failure) {
        log.error({ err: failure, from: peer.level, to: level }, 'coupling level not stored');
        if (level === 'manage') {
          // Raising failed: the coupling keeps `control` (the store changed nothing in memory).
          throw new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
        }
        // Lowering failed: fail closed – the coupling is revoked (§B.10 "Aufheben").
        await unpairNow(null, who.address, who.port);
        throw new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
      }
      // The old level must not send another command: new generation, every connection ends.
      generation += 1;
      hub.closeRemote(WS_CLOSE.SERVER_RESTARTING);
      listener.destroyPeerSockets();
      closeRemoteTerminals();
      record({
        kind: 'level_changed',
        ...who,
        claimedName: peer.name,
        detail: levelChangeDetail(peer.level, level),
      });
      log.info({ from: peer.level, to: level, by: local ? 'local' : 'remote' }, 'coupling level changed');
      emitChange();
    });

  const requireActive = (): MultiHostConfig => {
    if (active === null) throw new CommandError(makeError('REMOTE_ROLE_CONFLICT', { role: currentRole() }));
    return active;
  };

  const handle = async (cmd: HostCommand, ctx?: CommandContext): Promise<unknown> => {
    const config = requireActive();
    switch (cmd.name) {
      case 'remoteAccess.pair': {
        // Second line behind the hub (REMOTE_DENIED_COMMANDS): the code goes only to a local window.
        if (!isLocal(ctx)) throw new CommandError(makeError('REMOTE_NOT_ALLOWED', { command: cmd.name }));
        const bound = listener.address();
        if (bound === null)
          throw new CommandError(error ?? makeError('REMOTE_ACCESS_FAILED', { reason: 'listen' }));
        const opened = window.open(cmd.level ?? 'control');
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
        if (!isLocal(ctx)) throw new CommandError(makeError('REMOTE_NOT_ALLOWED', { command: cmd.name }));
        window.close('cancelled');
        return {};
      case 'remoteAccess.setPeerLevel':
        await setPeerLevel(cmd.level, ctx);
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
    handle: (cmd, ctx) => handle(cmd, ctx),
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
                level: peer.level,
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
    attachTerminal(service) {
      terminalService = service;
    },
    terminalConnections: () => bridgeReady?.connections() ?? 0,
    isCurrentConnection(socket) {
      if (socket instanceof GuardedHubSocket) return socket.isCurrent();
      return listener.isCurrentPeer(socket);
    },
    async close() {
      await service.deactivate();
      await peerHttp?.close();
      peerHttp = null;
      const bridge = terminalBridge;
      terminalBridge = null;
      bridgeReady = null;
      await bridge?.then((created) => created.close()).catch(() => undefined);
      await eventLog.close();
    },
  };
  return service;
}
