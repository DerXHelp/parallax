/**
 * `HostsService` – the controlling side of "Several computers" (docs/wp/WP-75.md §4.3, WP-76 §B.6–B.8):
 * `hosts.json`, the coupling as client (`hosts.add`), one `PinnedAgent` per computer, status and
 * versions (`HostState.remoteHosts`), the watchers and the forwarder for the HTTP layer.
 *
 * Keys (§B.5): the coupling key is a key file `coupling:<hostId>` (`IdentityStore`), kAuth sits
 * DPAPI-protected in the record (`authKey`, purpose `auth:<hostId>`). Plaintext kAuth lives only in
 * the agent (zeroed by `destroy()`); the copies here are zeroed right after use. The pairing code
 * (a JS string in the command) cannot be overwritten; its decoded bytes are.
 *
 * Role (`RoleSide`, `role: 'control'`): `activate` creates the computers in status `connecting` and
 * loads their keys one after the other in the background (each a DPAPI call), then starts the
 * watchers; `deactivate` ends every connection – the couplings stay. All `hosts.*` commands need the
 * active role (REMOTE_ROLE_CONFLICT otherwise). File changes run one after the other.
 */
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import { LIMITS, type HostId } from '@shared/common';
import { makeError } from '@shared/errors';
import { REMOTE_PATHS } from '@shared/http';
import { hostRecordSchema, type HostRecord, type MultiHostRole, type RemoteHost } from '@shared/model';
import { parsePairingCode } from '@shared/pairing';
import { WS_CLOSE, type HostCommand, type HostCommandName } from '@shared/protocol';
import type { ServerInstance } from '../config';
import { logger as rootLogger } from '../lib/logger';
import { computerName } from '../remote/addresses';
import { generateIdentity, makeIdentity } from '../secure/identity';
import { createIdentityStore, type FileIdentityStore } from '../secure/identityStore';
import {
  PairingClientError,
  pairWithHost,
  type PairWithHostOptions,
  type PairWithHostResult,
} from '../secure/pairingClient';
import { HandshakeGate, PinnedAgent, type PinnedAgentOptions } from '../secure/pinnedAgent';
import { KeyStoreError, type Identity, type KeyStore } from '../secure/ports';
import { SECRET_BYTES } from '../secure/tlsProfile';
import type { StoreWarningSink } from '../store/jsonStore';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import {
  HOSTS_TIMING,
  HOST_LIMITS,
  HostLink,
  destroyAgents,
  hostTarget,
  upstreamRequest,
  type HostLimits,
  type HostsTiming,
  type LinkAgents,
} from './link';
import { pickColor, uniqueHostId } from './naming';
import { HostForwarderError, type HostForwarder, type HostsService, type RelayEvents } from './ports';
import { HOSTS_FILE, createHostsStore, type HostsStore } from './store';

export const HOSTS_COMMANDS = [
  'hosts.add',
  'hosts.update',
  'hosts.move',
  'hosts.remove',
  'hosts.reconnect',
] as const satisfies readonly HostCommandName[];

type AddCommand = Extract<HostCommand, { name: 'hosts.add' }>;

/** `lastConnectedAt` is written at most this often per computer. */
const LAST_CONNECTED_WRITE_MS = 60_000;

export interface HostsServiceOptions {
  home: string;
  /** This server's version (REMOTE_HEADERS, compatibility) and build id (relay hello). */
  instance: Pick<ServerInstance, 'serverVersion' | 'buildId'>;
  keyStore: KeyStore;
  /** The role for REMOTE_ROLE_CONFLICT {role} while this side is inactive (default `off`). */
  currentRole?: () => MultiHostRole;
  warnings?: StoreWarningSink;
  identityStore?: FileIdentityStore;
  store?: HostsStore;
  /** The name this computer gives itself when pairing (default: the Windows computer name). */
  deviceName?: () => string;
  now?: () => Date;
  logger?: Logger;
  timing?: Partial<HostsTiming>;
  limits?: Partial<HostLimits>;
  /** Test seam (default `pairWithHost`). */
  pair?: (options: PairWithHostOptions) => Promise<PairWithHostResult>;
  /** Shorter agent timeouts (tests). */
  agentOptions?: Pick<PinnedAgentOptions, 'connectTimeoutMs' | 'proofTimeoutMs'>;
}

/**
 * WP-107 (E3, docs/wp/WP-76.md §B.13): the forwarder also opens the embedded terminal of the other
 * computer (`REMOTE_PATHS.terminalWs` over the coupling's pinned agent, counted like a window).
 */
export interface TerminalForwarder extends HostForwarder {
  /** Throws HostForwarderError like `connectWindow`. */
  connectTerminal(hostId: HostId, signal?: AbortSignal): Promise<WebSocket>;
}

/** The port plus what the role service and compose use (`ManagedRoleSide`). */
export interface Hosts extends HostsService {
  readonly forwarder: TerminalForwarder;
  /** Reads `hosts.json` so that `couplings()` is right before activation; idempotent. */
  prepare(): Promise<void>;
  /** Deactivates (server shutdown, tests). */
  close(): Promise<void>;
  /** Open window connections of a computer (diagnostics and tests). */
  windowCount(hostId: HostId): number;
}

function commandError(code: Parameters<typeof makeError>[0], params: Parameters<typeof makeError>[1] = {}) {
  return new CommandError(makeError(code, params));
}

export function createHostsService(options: HostsServiceOptions): Hosts {
  const log = (options.logger ?? rootLogger).child({ module: 'hosts' });
  const now = options.now ?? (() => new Date());
  const timing: HostsTiming = { ...HOSTS_TIMING, ...options.timing };
  const limits: HostLimits = { ...HOST_LIMITS, ...options.limits };
  const appVersion = options.instance.serverVersion;
  const currentRole = options.currentRole ?? ((): MultiHostRole => 'off');
  const pair = options.pair ?? pairWithHost;
  const deviceName =
    options.deviceName ?? ((): string => computerName().slice(0, LIMITS.hostNameChars).trim() || 'parallax');
  const { keyStore } = options;
  const storeOptions = {
    home: options.home,
    logger: options.logger ?? rootLogger,
    ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
  };
  const identityStore = options.identityStore ?? createIdentityStore({ ...storeOptions, keyStore });
  const store = options.store ?? createHostsStore(storeOptions);

  let records: HostRecord[] = [];
  let preparing: Promise<void> | null = null;
  let active = false;
  /** Raised by activate/deactivate: background loads of an older activation stop. */
  let epoch = 0;
  const links = new Map<HostId, HostLink>();
  /** Host ids of pairings in progress (count as couplings, ids reserved). */
  const pending = new Set<HostId>();
  const pairings = new Set<AbortController>();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<RelayEvents>();
  let lastList = '[]';

  const list = (): RemoteHost[] => {
    if (!active) return [];
    return records.flatMap((record) => {
      const view = links.get(record.hostId)?.view();
      return view === undefined ? [] : [view];
    });
  };

  const emit = (): void => {
    const next = JSON.stringify(list());
    if (next === lastList) return;
    lastList = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'hosts listener failed');
      }
    }
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const relay: RelayEvents = {
    notify(hostId, notification) {
      for (const listener of [...relayListeners]) listener.notify(hostId, notification);
    },
    clear(hostId, entryId) {
      for (const listener of [...relayListeners]) listener.clear(hostId, entryId);
    },
  };

  const requireActive = (): void => {
    if (!active) throw commandError('REMOTE_ROLE_CONFLICT', { role: currentRole() });
  };

  const requireWritable = (): void => {
    const blocked = store.blockedError();
    if (blocked !== null) throw new CommandError(blocked);
  };

  /** Writes `next` and makes it the list; STORE_WRITE_FAILED {file} on failure (the list stays). */
  const saveRecords = async (next: HostRecord[]): Promise<void> => {
    try {
      await store.save(next);
    } catch (error) {
      log.error({ err: error }, 'hosts.json not written');
      throw commandError('STORE_WRITE_FAILED', { file: HOSTS_FILE });
    }
    records = next;
  };

  const prepare = (): Promise<void> => {
    preparing ??= store.load().then((loaded) => {
      records = loaded;
    });
    return preparing;
  };

  // ---- links ----

  const noteConnected = (hostId: HostId, at: Date): void => {
    void serial(async () => {
      const index = records.findIndex((record) => record.hostId === hostId);
      const old = records[index];
      if (old === undefined || store.blockedError() !== null) return;
      const last = old.lastConnectedAt === null ? null : Date.parse(old.lastConnectedAt);
      if (last !== null && at.getTime() - last < LAST_CONNECTED_WRITE_MS) return;
      const next = { ...old, lastConnectedAt: at.toISOString() };
      try {
        await saveRecords(records.with(index, next));
        links.get(hostId)?.update(next);
      } catch {
        // logged by saveRecords; the time is shown from memory anyway
      }
    });
  };

  const newLink = (record: HostRecord): HostLink =>
    new HostLink(record, {
      appVersion,
      buildId: options.instance.buildId,
      timing,
      limits,
      logger: log,
      now,
      changed: emit,
      connected: (at) => {
        noteConnected(record.hostId, at);
      },
      relay,
    });

  /** HTTP and WebSocket agents of one coupling, one shared handshake gate (each copies kAuth). */
  const buildAgents = (
    identity: Identity,
    record: Pick<HostRecord, 'peerCertificate' | 'peerPin'>,
    authKey: Buffer,
  ): LinkAgents => {
    const shared = {
      identity,
      peerCertificateDer: Buffer.from(record.peerCertificate, 'base64'),
      peerPin: record.peerPin,
      authKey,
      gate: new HandshakeGate(),
      ...options.agentOptions,
    };
    const http = new PinnedAgent({ ...shared, maxSockets: limits.httpSockets });
    try {
      return { http, ws: new PinnedAgent({ ...shared, keepAlive: false }) };
    } catch (error) {
      http.destroy();
      throw error;
    }
  };

  /** Key file + DPAPI(kAuth) → agent (plaintext zeroed). Throws KeyStoreError or a plain Error (key missing/broken). */
  const loadAgents = async (record: HostRecord): Promise<LinkAgents> => {
    const identity = await identityStore.load(`coupling:${record.hostId}`);
    if (identity === null) throw new Error('coupling key missing');
    const plain = await keyStore.unprotect(`auth:${record.hostId}`, Buffer.from(record.authKey, 'base64'));
    try {
      if (plain.length !== SECRET_BYTES) throw new KeyStoreError('failed');
      return buildAgents(identity, record, plain);
    } finally {
      plain.fill(0);
    }
  };

  const startLink = async (link: HostLink, startEpoch: number): Promise<void> => {
    const hostId = link.record.hostId;
    try {
      const agents = await loadAgents(link.record);
      if (epoch !== startEpoch || links.get(hostId) !== link) {
        destroyAgents(agents);
        return;
      }
      link.attach(agents);
    } catch (error) {
      if (epoch !== startEpoch || links.get(hostId) !== link) return;
      if (error instanceof KeyStoreError) {
        log.error({ hostId, reason: error.reason }, 'coupling secret not readable (key store)');
        link.failLoad('unreachable', makeError('REMOTE_KEYSTORE_UNAVAILABLE'));
      } else {
        log.error({ hostId, err: error }, 'coupling key missing or broken – pair again');
        link.failLoad('revoked', makeError('HOST_REVOKED', { reason: 'key' }));
      }
    }
  };

  const loadLinks = async (startEpoch: number): Promise<void> => {
    // One after the other: every load decrypts a key and kAuth (DPAPI, keeps the start order stable).
    for (const link of [...links.values()]) {
      if (epoch !== startEpoch) return;
      await startLink(link, startEpoch);
    }
  };

  // ---- commands ----

  const add = async (cmd: AddCommand): Promise<{ hostId: HostId }> => {
    requireActive();
    requireWritable();
    const code = parsePairingCode(cmd.code);
    if (code === null) throw commandError('VALIDATION_FAILED', { reason: 'code' });
    let reserved: HostId | null = null;
    let result: PairWithHostResult | null = null;
    try {
      let keyId: HostId;
      if (cmd.replaceHostId === undefined) {
        if (records.length + pending.size >= LIMITS.hostsMax) {
          throw commandError('VALIDATION_FAILED', { reason: 'limit' });
        }
        reserved = uniqueHostId(
          cmd.displayName,
          new Set([...records.map((record) => record.hostId), ...pending]),
        );
        pending.add(reserved);
        keyId = reserved;
      } else {
        // Pairing an existing entry again does not count twice towards LIMITS.hostsMax.
        keyId = findRecord(cmd.replaceHostId).record.hostId;
      }
      if (!(await keyStore.available())) throw commandError('REMOTE_KEYSTORE_UNAVAILABLE');
      const identity = generateIdentity(`coupling:${keyId}`);
      const controller = new AbortController();
      pairings.add(controller);
      try {
        result = await pair({
          address: cmd.address,
          port: cmd.port,
          code,
          deviceName: deviceName(),
          identity,
          appVersion,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && !active) {
          throw commandError('REMOTE_ROLE_CONFLICT', { role: currentRole() });
        }
        if (error instanceof PairingClientError) throw new CommandError(error.error);
        throw error;
      } finally {
        pairings.delete(controller);
      }
      return { hostId: await commitPairing(cmd, identity, result, reserved) };
    } finally {
      code.fill(0);
      result?.authKey.fill(0);
      if (reserved !== null) pending.delete(reserved);
    }
  };

  /**
   * §B.7 step 8 after a verified macB: store key, kAuth and pins – or undo everything. Target:
   * `replaceHostId`; else an entry with the same pin (the same sharing computer paired again
   * replaces that entry instead of becoming a duplicate); else the new entry `reserved`. A replaced
   * entry keeps hostId, color, place and addedAt; its old agent, key and windows (HOST_REVOKED) go.
   */
  const commitPairing = async (
    cmd: AddCommand,
    generated: Identity,
    result: PairWithHostResult,
    reserved: HostId | null,
  ): Promise<HostId> => {
    /** Puts the key file back as it was (set while only the key file is new). */
    const undo: { key: (() => Promise<void>) | null } = { key: null };
    try {
      return await serial(async () => {
        requireWritable();
        const replaceId =
          cmd.replaceHostId ?? records.find((record) => record.peerPin === result.peerPin)?.hostId;
        const index =
          replaceId === undefined ? -1 : records.findIndex((record) => record.hostId === replaceId);
        const old = records[index];
        if (replaceId !== undefined && old === undefined) {
          throw commandError('HOST_NOT_FOUND', { hostId: replaceId });
        }
        const hostId = old?.hostId ?? reserved;
        if (hostId === null) throw new Error('pairing without a target entry');
        const purpose = `coupling:${hostId}` as const;
        const identity =
          generated.purpose === purpose
            ? generated
            : makeIdentity(purpose, generated.privateKey, generated.certificateDer);
        const sealed = await keyStore.protect(`auth:${hostId}`, result.authKey);
        const previous =
          old === undefined ? null : await identityStore.load(purpose).catch((): Identity | null => null);
        await identityStore.save(identity);
        undo.key =
          previous === null ? () => identityStore.remove(purpose) : () => identityStore.save(previous);
        const record = hostRecordSchema.parse({
          ...(old ?? {
            hostId,
            color: pickColor(records.map((host) => host.color)),
            addedAt: now().toISOString(),
            lastConnectedAt: null,
          }),
          name: cmd.displayName,
          address: cmd.address,
          port: cmd.port,
          peerPin: result.peerPin,
          peerCertificate: result.peerCertificateDer.toString('base64'),
          authKey: sealed.toString('base64'),
        });
        await saveRecords(old === undefined ? [...records, record] : records.with(index, record));
        undo.key = null;
        if (old !== undefined) {
          links.get(hostId)?.stop(WS_CLOSE.HOST_REVOKED);
          links.delete(hostId);
        }
        if (active) {
          const link = newLink(record);
          links.set(hostId, link);
          link.attach(buildAgents(identity, record, result.authKey));
        }
        emit();
        log.info(
          { hostId, peerPin: result.peerPin },
          old === undefined ? 'computer added' : 'computer paired again',
        );
        return hostId;
      });
    } catch (error) {
      // The other computer already holds the coupling: ask it to drop it again (best effort).
      await undoRemote(generated, cmd, result);
      await undo.key?.().catch((failure: unknown) => {
        log.warn({ err: failure }, 'coupling key of a failed pairing not restored');
      });
      if (error instanceof CommandError) throw error;
      if (error instanceof KeyStoreError) throw commandError('REMOTE_KEYSTORE_UNAVAILABLE');
      log.error({ err: error }, 'coupling not stored');
      throw commandError('STORE_WRITE_FAILED', { file: HOSTS_FILE });
    }
  };

  const undoRemote = async (
    identity: Identity,
    target: Pick<HostRecord, 'address' | 'port'>,
    result: PairWithHostResult,
  ): Promise<void> => {
    let agent: PinnedAgent | null = null;
    try {
      agent = new PinnedAgent({
        identity,
        peerCertificateDer: result.peerCertificateDer,
        peerPin: result.peerPin,
        authKey: result.authKey,
        keepAlive: false,
        ...options.agentOptions,
      });
      const response = await upstreamRequest(
        agent,
        hostTarget(target),
        appVersion,
        { method: 'DELETE', path: REMOTE_PATHS.peerSelf, query: '', headers: {} },
        { timeoutMs: timing.unpairTimeoutMs },
      );
      response.body.resume();
      log.info({ status: response.status }, 'coupling of a failed pairing dropped on the other computer');
    } catch {
      log.warn('coupling of a failed pairing could not be dropped on the other computer');
    } finally {
      agent?.destroy();
    }
  };

  const findRecord = (hostId: HostId): { index: number; record: HostRecord } => {
    const index = records.findIndex((record) => record.hostId === hostId);
    const record = records[index];
    if (record === undefined) throw commandError('HOST_NOT_FOUND', { hostId });
    return { index, record };
  };

  const update = (cmd: Extract<HostCommand, { name: 'hosts.update' }>): Promise<Record<string, never>> =>
    serial(async () => {
      requireActive();
      const { index, record } = findRecord(cmd.hostId);
      requireWritable();
      const next = hostRecordSchema.parse({
        ...record,
        name: cmd.displayName ?? record.name,
        color: cmd.color ?? record.color,
        address: cmd.address ?? record.address,
        port: cmd.port ?? record.port,
      });
      await saveRecords(records.with(index, next));
      links.get(next.hostId)?.update(next);
      emit();
      return {};
    });

  const move = (cmd: Extract<HostCommand, { name: 'hosts.move' }>): Promise<Record<string, never>> =>
    serial(async () => {
      requireActive();
      const { index, record } = findRecord(cmd.hostId);
      const target = Math.min(cmd.index, records.length - 1);
      if (target === index) return {};
      requireWritable();
      const next = records.filter((host) => host.hostId !== cmd.hostId);
      next.splice(target, 0, record);
      await saveRecords(next);
      emit();
      return {};
    });

  const remove = async (hostId: HostId): Promise<{ peerNotified: boolean }> => {
    requireActive();
    findRecord(hostId);
    requireWritable();
    // §B.8: 1. ask the other computer to drop the coupling (when reachable; false = by hand there) …
    const peerNotified = (await links.get(hostId)?.unpairRemote()) ?? false;
    return serial(async () => {
      const index = records.findIndex((record) => record.hostId === hostId);
      if (index < 0) return { peerNotified };
      // … 2. then agent, key, certificate, pin and kAuth go here.
      await saveRecords(records.filter((record) => record.hostId !== hostId));
      links.get(hostId)?.stop(WS_CLOSE.HOST_REVOKED);
      links.delete(hostId);
      try {
        await identityStore.remove(`coupling:${hostId}`);
      } catch (error) {
        log.warn({ err: error, hostId }, 'coupling key file not removed');
      }
      log.info({ hostId, peerNotified }, 'computer removed');
      emit();
      return { peerNotified };
    });
  };

  const reconnect = (hostId: HostId): Record<string, never> => {
    requireActive();
    findRecord(hostId);
    const link = links.get(hostId);
    if (link === undefined) throw commandError('HOST_NOT_FOUND', { hostId });
    if (link.hasAgent) link.reconnect();
    else void startLink(link, epoch);
    return {};
  };

  const handle = async (cmd: HostCommand): Promise<unknown> => {
    switch (cmd.name) {
      case 'hosts.add':
        return add(cmd);
      case 'hosts.update':
        return update(cmd);
      case 'hosts.move':
        return move(cmd);
      case 'hosts.remove':
        return remove(cmd.hostId);
      case 'hosts.reconnect':
        return reconnect(cmd.hostId);
      default:
        throw commandError('NOT_IMPLEMENTED', { command: cmd.name });
    }
  };

  const commands: HostCommandHandler = { names: HOSTS_COMMANDS, handle: (cmd) => handle(cmd) };

  // ---- forwarder ----

  const linkFor = (hostId: HostId): HostLink => {
    const link = active ? links.get(hostId) : undefined;
    if (link === undefined) throw new HostForwarderError(makeError('HOST_NOT_FOUND'));
    return link;
  };

  const forwarder: TerminalForwarder = {
    connectWindow(hostId, signal) {
      try {
        return linkFor(hostId).connectWindow(signal);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    connectTerminal(hostId, signal) {
      try {
        return linkFor(hostId).connectWindow(signal, REMOTE_PATHS.terminalWs);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    request(hostId, request) {
      try {
        return linkFor(hostId).request(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    closeWindows(hostId, code) {
      if (hostId === null) for (const link of links.values()) link.closeWindows(code);
      else links.get(hostId)?.closeWindows(code);
    },
  };

  // ---- role side ----

  const deactivate = (): Promise<void> =>
    serial(async () => {
      if (!active) return;
      active = false;
      epoch += 1;
      for (const controller of pairings) controller.abort();
      for (const link of links.values()) link.stop(WS_CLOSE.SERVER_SHUTDOWN);
      links.clear();
      log.info('controlling side inactive');
      emit();
      await Promise.resolve();
    });

  const service: Hosts = {
    role: 'control',
    commands,
    forwarder,
    list,
    couplings() {
      const count = records.length + pending.size;
      // An unreadable hosts.json may hold couplings: fail closed for the role switch (ADR-224).
      return store.blockedError() !== null ? Math.max(count, 1) : count;
    },
    prepare,
    activate: () =>
      serial(async () => {
        if (active) return;
        await prepare();
        active = true;
        epoch += 1;
        for (const record of records) links.set(record.hostId, newLink(record));
        log.info({ computers: records.length }, 'controlling side active');
        emit();
        void loadLinks(epoch);
      }),
    deactivate,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRelay(listener) {
      relayListeners.add(listener);
      return () => {
        relayListeners.delete(listener);
      };
    },
    close: deactivate,
    windowCount: (hostId) => links.get(hostId)?.windowCount() ?? 0,
  };
  return service;
}
