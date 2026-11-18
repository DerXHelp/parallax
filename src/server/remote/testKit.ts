/**
 * Test helpers for remote access (tests only): a sharing service on 127.0.0.1 with port 0, a fake
 * hub, the memory key store, and the controlling side built from `secure/` (pairWithHost,
 * PinnedAgent). Never binds 0.0.0.0 or a LAN address (Windows firewall dialog).
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import type { ClientId } from '@shared/common';
import type { MultiHostConfig } from '@shared/model';
import { REMOTE_PATHS } from '@shared/http';
import type { HostCommand } from '@shared/protocol';
import type { ServerInstance } from '../config';
import { makeTempHome } from '../http/testServer';
import { generateIdentity } from '../secure/identity';
import { createMemoryKeyStore, type MemoryKeyStore } from '../secure/memoryKeyStore';
import { pairWithHost, type PairWithHostOptions, type PairWithHostResult } from '../secure/pairingClient';
import { encodeMac, pairingKey, pairingMac, pairingMaterial } from '../secure/pairingCrypto';
import { PinnedAgent, remoteVersionHeaders } from '../secure/pinnedAgent';
import type { Identity } from '../secure/ports';
import { TEST_HOST, identityCredentials } from '../secure/testKit';
import { TLS_PROFILE } from '../secure/tlsProfile';
import type { HubSocket } from '../sync/hub';
import { REMOTE_LIMITS, type RemoteLimits } from './limits';
import type { RemoteConnectionInfo, RemoteHubAttach } from './ports';
import { createRemoteAccessService, type RemoteAccess, type RemoteAccessServiceOptions } from './service';

export const TEST_VERSION = '1.2.3';
export const TEST_CLIENT: ClientId = 'cl_00000000000000000000000000000001';

/** Limits that do not get in the way of a test that opens many connections from 127.0.0.1. */
export const OPEN_LIMITS: RemoteLimits = {
  ...REMOTE_LIMITS,
  maxConnections: 500,
  perAddressConcurrent: 200,
  perAddressBurst: 1_000,
  perAddressPerMinute: 1_000,
  pairingPerAddressPerMinute: 1_000,
  pairingTotalPerMinute: 1_000,
};

export function testInstance(): ServerInstance {
  return {
    serverInstanceId: randomUUID(),
    serverVersion: TEST_VERSION,
    buildId: 'test',
    startedAt: '2026-11-18T10:00:00.000Z',
  };
}

export interface FakeHub extends RemoteHubAttach {
  readonly sockets: { socket: HubSocket; info: RemoteConnectionInfo }[];
  readonly closed: number[];
}

/** Echoes every message (`echo:<text>`), records closeRemote codes. */
export function createFakeHub(): FakeHub {
  const sockets: { socket: HubSocket; info: RemoteConnectionInfo }[] = [];
  const closed: number[] = [];
  return {
    sockets,
    closed,
    handleRemoteConnection(socket, info) {
      sockets.push({ socket, info });
      socket.on('message', (data) => {
        const text = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        socket.send(`echo:${text.toString('utf8')}`);
      });
    },
    remoteConnections: () => sockets.filter((entry) => entry.socket.readyState === 1).length,
    closeRemote(code) {
      closed.push(code);
      for (const entry of sockets) entry.socket.close(code);
    },
  };
}

export const SHARE_CONFIG: MultiHostConfig = { role: 'share', port: 0, bindAddress: TEST_HOST };

export interface Harness {
  home: string;
  service: RemoteAccess;
  hub: FakeHub;
  keyStore: MemoryKeyStore;
  instance: ServerInstance;
  /** Requests that reached the content test route (`GET /remote/v1/blob/:blobId`). */
  blobHits: string[];
  port(): number;
  command(cmd: HostCommand): Promise<unknown>;
  /** Opens a pairing window and pairs a new controlling identity. */
  pair(overrides?: Partial<PairWithHostOptions>): Promise<PairWithHostResult & { identity: Identity }>;
  /** pairWithHost against `port` with `code` (no window is opened). */
  pairTo(port: number, code: string | Uint8Array): Promise<PairWithHostResult>;
  agent(paired: PairWithHostResult & { identity: Identity }): PinnedAgent;
  close(): Promise<void>;
}

export async function startHarness(
  options: Omit<Partial<RemoteAccessServiceOptions>, 'keyStore'> & {
    keyStore?: MemoryKeyStore;
    activate?: boolean;
  } = {},
): Promise<Harness> {
  const { activate, keyStore: givenKeyStore, ...serviceOptions } = options;
  const home = options.home ?? (await makeTempHome('wp78a-remote-'));
  const hub = createFakeHub();
  const keyStore = givenKeyStore ?? createMemoryKeyStore();
  const instance = options.instance ?? testInstance();
  const blobHits: string[] = [];
  const agents: PinnedAgent[] = [];
  const service = createRemoteAccessService({
    home,
    instance,
    hub,
    limits: OPEN_LIMITS,
    selfTest: () => Promise.resolve(null),
    detectAddresses: () => ['10.0.0.5'],
    hostName: () => 'PC-B',
    registerContent: (app, context) => {
      app.get<{ Params: { blobId: string } }>(REMOTE_PATHS.blob, (req, reply) => {
        if (!context.isCurrent(req)) {
          reply.hijack();
          req.raw.socket.destroy();
          return reply;
        }
        blobHits.push(req.params.blobId);
        return { blob: req.params.blobId };
      });
    },
    ...serviceOptions,
    keyStore,
  });
  await service.prepare();
  if (activate !== false) await service.activate(SHARE_CONFIG);
  const port = (): number => {
    const value = service.state()?.port;
    if (typeof value !== 'number') throw new Error('not listening');
    return value;
  };
  const command = (cmd: HostCommand): Promise<unknown> =>
    service.commands.handle(cmd, { clientId: TEST_CLIENT, cmdId: 'c1' });
  return {
    home,
    service,
    hub,
    keyStore,
    instance,
    blobHits,
    port,
    command,
    async pair(overrides = {}) {
      const opened = (await command({ name: 'remoteAccess.pair' })) as { code: string };
      const identity = generateIdentity('coupling:pc-b');
      const result = await pairWithHost({
        address: TEST_HOST,
        port: port(),
        code: opened.code,
        deviceName: 'PC-A',
        identity,
        appVersion: TEST_VERSION,
        timeoutMs: 5_000,
        ...overrides,
      });
      return { ...result, identity };
    },
    pairTo(target, code) {
      return pairWithHost({
        address: TEST_HOST,
        port: target,
        code,
        deviceName: 'PC-A',
        identity: generateIdentity('coupling:pc-b'),
        appVersion: TEST_VERSION,
        timeoutMs: 5_000,
      });
    },
    agent(paired) {
      const agent = new PinnedAgent({
        identity: paired.identity,
        peerCertificateDer: paired.peerCertificateDer,
        peerPin: paired.peerPin,
        authKey: paired.authKey,
        connectTimeoutMs: 3_000,
        proofTimeoutMs: 3_000,
      });
      agents.push(agent);
      return agent;
    },
    async close() {
      for (const agent of agents) agent.destroy();
      await service.close();
    },
  };
}

export interface HttpAnswer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** An HTTPS request through a PinnedAgent (version headers by default). */
export function agentRequest(
  agent: PinnedAgent,
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: TEST_HOST,
        port,
        path,
        agent,
        method: options.method ?? 'GET',
        headers: { ...remoteVersionHeaders(TEST_VERSION), ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * A raw TLS connection with `identity` (or none / foreign credentials) that writes `early` right
 * away – the bytes leave in the same flight as the client Finished (§B.12 "vor HTTP"). Resolves when
 * the connection closed, with what came back.
 */
export function rawExchange(
  port: number,
  credentials: { key?: string; cert?: string; sigalgs?: string } | null,
  early: string | Buffer,
  timeoutMs = 3_000,
): Promise<{ secured: boolean; received: Buffer; error: string | null }> {
  return new Promise((resolve) => {
    let secured = false;
    let error: string | null = null;
    const chunks: Buffer[] = [];
    const socket: TLSSocket = connect({
      ...TLS_PROFILE,
      ...(credentials ?? {}),
      host: TEST_HOST,
      port,
      servername: '',
      rejectUnauthorized: false,
    });
    socket.write(early);
    socket.on('secureConnect', () => {
      secured = true;
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (failure: Error) => {
      error = failure.message;
    });
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ secured, received: Buffer.concat(chunks), error });
    });
  });
}

export { identityCredentials };

/** A pairing connection (§B.7 step 1) with `identity` as client certificate; resolves after the handshake. */
export function pairingSocket(port: number, identity: Identity): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      ...TLS_PROFILE,
      ...identityCredentials(identity),
      host: TEST_HOST,
      port,
      servername: '',
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** The pairing body for `socket` (macA over this connection) – §B.7 steps 2–5. */
export function pairBody(socket: TLSSocket, code: Uint8Array, deviceName = 'PC-A'): string {
  const material = pairingMaterial(socket, 'client');
  const k = pairingKey(code);
  const macA = pairingMac(k, 'initiator', material.transcript);
  return JSON.stringify({ deviceName, macA: encodeMac(macA) });
}

/** Writes one raw HTTP request and reads until the server closes; `status` 0 = closed without answer. */
export function rawRequest(
  socket: TLSSocket,
  options: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve({ status: 0, body: '' });
      return;
    }
    const body = options.body ?? '';
    const headers: Record<string, string> = {
      host: TEST_HOST,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      connection: 'close',
      ...remoteVersionHeaders(TEST_VERSION),
      ...options.headers,
    };
    const head = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.once('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(text);
      const split = text.indexOf('\r\n\r\n');
      resolve({
        status: match === null ? 0 : Number(match[1]),
        body: split < 0 ? '' : text.slice(split + 4),
      });
    });
    socket.write(
      `${options.method ?? 'POST'} ${options.path ?? REMOTE_PATHS.pair} HTTP/1.1\r\n${head}\r\n\r\n${body}`,
    );
  });
}
