import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { HOSTS_SCHEMA_VERSION, remoteHostSchema, type HostRecord } from '@shared/model';
import { formatPairingCode } from '@shared/pairing';
import { PROTOCOL_VERSION, WS_CLOSE, parseServerMessage } from '@shared/protocol';
import type { ManagedRoleSide } from '../multihost/service';
import { generateIdentity } from '../secure/identity';
import { keyFilePath } from '../secure/identityStore';
import { encodeMac } from '../secure/pairingCrypto';
import { identityCredentials, startTlsServer } from '../secure/testKit';
import { HostForwarderError } from './ports';
import { HOSTS_FILE } from './store';
import {
  TEST_HOST,
  hostCommand,
  rejection,
  startControl,
  startSharing,
  type ControlSide,
  type SharingSide,
} from './testKit';
import { browserCloseCode } from './windows';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sharing(options: Parameters<typeof startSharing>[0] = {}): Promise<SharingSide> {
  const side = await startSharing(options);
  cleanups.push(() => side.close());
  return side;
}

async function control(options: Parameters<typeof startControl>[0] = {}): Promise<ControlSide> {
  const side = await startControl(options);
  cleanups.push(() => side.close());
  return side;
}

async function hostsFile(home: string): Promise<HostRecord[]> {
  const raw = JSON.parse(await readFile(path.join(home, HOSTS_FILE), 'utf8')) as { hosts: HostRecord[] };
  return raw.hosts;
}

async function forwarderError(promise: Promise<unknown>): Promise<HostForwarderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HostForwarderError) return error;
    throw error;
  }
  throw new Error('expected a HostForwarderError');
}

function closedCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) resolve(1006);
    else
      ws.once('close', (code: number) => {
        resolve(code);
      });
  });
}

function nextMessage(ws: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer): void => {
      const parsed = parseServerMessage(data.toString('utf8'));
      if (parsed.ok === true && parsed.message.type === type) {
        ws.off('message', onMessage);
        resolve(parsed.message);
      }
    };
    ws.on('message', onMessage);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('hosts service: pairing', () => {
  it('pairs with a sharing computer, stores only after success and connects the relay', async () => {
    const logs: string[] = [];
    const logger = pino(
      { level: 'trace' },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(chunk.toString('utf8'));
          done();
        },
      }),
    );
    const b = await sharing();
    const a = await control({ logger });
    const code = await b.code();
    const result = await hostCommand(a, {
      name: 'hosts.add',
      address: TEST_HOST,
      port: b.port(),
      code,
      displayName: 'PC B',
    });
    expect(result).toEqual({ hostId: 'pc-b' });
    const host = await a.waitFor('pc-b', 'connected');
    expect(remoteHostSchema.parse(host)).toMatchObject({
      hostId: 'pc-b',
      name: 'PC B',
      color: 'blue',
      address: TEST_HOST,
      port: b.port(),
      appVersion: b.version,
      protocolVersion: PROTOCOL_VERSION,
      lastError: null,
    });
    expect(host.lastConnectedAt).not.toBeNull();
    expect(a.service.couplings()).toBe(1);

    // stored: record (pins, DPAPI(kAuth)), key file; the other side knows us under our name
    const [record] = await hostsFile(a.home);
    expect(record?.hostId).toBe('pc-b');
    expect(record?.peerPin).toMatch(/^[0-9a-f]{96}$/u);
    expect(existsSync(keyFilePath(a.home, 'coupling:pc-b'))).toBe(true);
    expect(
      a.keyStore.calls
        .filter((call) => call.op === 'protect')
        .map((call) => call.purpose)
        .sort(),
    ).toEqual(['auth:pc-b', 'coupling:pc-b']);
    expect(b.harness.service.state()?.peer).toMatchObject({ name: 'PC-A', connected: true });
    // the relay is a relay on the other side
    await expect.poll(() => b.relayClientId()).not.toBeNull();

    // no secret in HostState, results or logs
    if (record === undefined) throw new Error('record missing');
    const kAuth = await a.keyStore.unprotect('auth:pc-b', Buffer.from(record.authKey, 'base64'));
    const visible = JSON.stringify([a.service.list(), result]);
    const logText = logs.join('\n');
    for (const secret of [code, code.replace(/-/gu, ''), kAuth.toString('hex'), kAuth.toString('base64')]) {
      expect(visible).not.toContain(secret);
      expect(logText).not.toContain(secret);
    }
    expect(visible).not.toContain(record.peerPin);
    expect(visible).not.toContain(record.authKey);
  });

  it('a wrong macB stores nothing', async () => {
    const server = generateIdentity('identity');
    const http = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            macB: encodeMac(randomBytes(48)),
            hostName: 'PC-X',
            appVersion: '1.2.3',
            protocolVersion: PROTOCOL_VERSION,
          }),
        );
      });
    });
    const tls = await startTlsServer(
      { ...identityCredentials(server), requestCert: true, rejectUnauthorized: false },
      (socket) => {
        http.emit('connection', socket);
      },
    );
    cleanups.push(async () => {
      await tls.close();
      http.close();
    });
    const a = await control();
    // a mistyped code fails locally and never reaches the network
    const typo = await rejection(
      hostCommand(a, {
        name: 'hosts.add',
        address: TEST_HOST,
        port: tls.port,
        code: 'ABCD',
        displayName: 'PC X',
      }),
    );
    expect(typo.error).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'code' } });

    const b = await sharing();
    const valid = await b.code();
    const invalid = await rejection(
      hostCommand(a, {
        name: 'hosts.add',
        address: TEST_HOST,
        port: tls.port,
        code: valid,
        displayName: 'PC X',
      }),
    );
    expect(invalid.error.code).toBe('PAIRING_INVALID');
    expect(existsSync(path.join(a.home, HOSTS_FILE))).toBe(false);
    expect(existsSync(keyFilePath(a.home, 'coupling:pc-x'))).toBe(false);
    expect(a.keyStore.size()).toBe(0);
    expect(a.service.list()).toEqual([]);
    expect(a.service.couplings()).toBe(0);
  });

  it('is the controlling side of the role service (ManagedRoleSide)', async () => {
    const a = await control({ activate: false });
    const side: ManagedRoleSide & { readonly role: 'control' } = a.service;
    expect(side.role).toBe('control');
    expect(side.couplings()).toBe(0);
    expect(a.service.list()).toEqual([]);
  });

  it('refuses hosts.* while the role is not control, and at the limit', async () => {
    const off = await control({ activate: false, currentRole: () => 'share' });
    const conflict = await rejection(hostCommand(off, { name: 'hosts.reconnect', hostId: 'pc-b' }));
    expect(conflict.error).toEqual({ code: 'REMOTE_ROLE_CONFLICT', params: { role: 'share' } });
    expect(off.service.list()).toEqual([]);

    const full = await control({ activate: false });
    const records = Array.from({ length: 16 }, (_, index) => ({
      hostId: `pc-${String(index)}`,
      name: `PC ${String(index)}`,
      color: 'blue',
      address: '192.0.2.1',
      port: 4713,
      peerPin: 'a'.repeat(96),
      peerCertificate: 'AAAA',
      authKey: 'AAAA',
      addedAt: '2026-11-18T10:00:00.000Z',
      lastConnectedAt: null,
    }));
    await writeFile(
      path.join(full.home, HOSTS_FILE),
      JSON.stringify({ schemaVersion: HOSTS_SCHEMA_VERSION, hosts: records }),
    );
    const again = await control({ home: full.home, keyStore: full.keyStore });
    expect(again.service.couplings()).toBe(16);
    // keys missing → the computers show `revoked` (pair again), nothing crashes
    await again.waitFor('pc-0', 'revoked');
    const b = await sharing();
    const limit = await rejection(
      hostCommand(again, {
        name: 'hosts.add',
        address: TEST_HOST,
        port: b.port(),
        code: await b.code(),
        displayName: 'PC',
      }),
    );
    expect(limit.error).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'limit' } });
    expect(b.harness.service.state()?.peer).toBeNull();
    // pairing an existing entry again does not count twice
    const replaced = await hostCommand(again, {
      name: 'hosts.add',
      address: TEST_HOST,
      port: b.port(),
      code: await b.code(),
      displayName: 'PC 0',
      replaceHostId: 'pc-0',
    });
    expect(replaced).toEqual({ hostId: 'pc-0' });
    await again.waitFor('pc-0', 'connected');
    expect(again.service.couplings()).toBe(16);
  });
});

describe('hosts service: status', () => {
  it('relay notifications go to the onRelay listeners', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    await expect.poll(() => b.relayClientId()).not.toBeNull();
    const relayId = b.relayClientId();
    if (relayId === null) throw new Error('no relay');
    const notification = {
      id: 'n1',
      kind: 'permission' as const,
      entryId: 'en_00000000000000000000000000000001',
      title: 'Session',
      delivery: 'system' as const,
      at: '2026-11-18T10:00:00.000Z',
    };
    b.hub.notify(relayId, notification);
    b.hub.clearNotification('en_00000000000000000000000000000001');
    await expect.poll(() => a.relayed.clear.length).toBe(1);
    expect(a.relayed.notify).toEqual([{ hostId, notification }]);
    expect(a.relayed.clear).toEqual([{ hostId, entryId: 'en_00000000000000000000000000000001' }]);
  });

  it('another version on the other side → incompatible, no retry until hosts.reconnect', async () => {
    const b = await sharing();
    const first = await control();
    const hostId = await first.add(b);
    await first.waitFor(hostId, 'connected');
    await first.close();

    const newer = await control({ home: first.home, keyStore: first.keyStore, version: '1.2.4' });
    const host = await newer.waitFor(hostId, 'incompatible');
    expect(host.lastError).toEqual({
      code: 'HOST_INCOMPATIBLE',
      params: { version: b.version, protocol: PROTOCOL_VERSION },
    });
    expect(host.appVersion).toBe(b.version);
    const refused = await forwarderError(newer.service.forwarder.connectWindow(hostId));
    expect(refused.error.code).toBe('HOST_INCOMPATIBLE');
    const seen = b.harness.service.state()?.peer?.appVersion;
    await sleep(500);
    expect(newer.service.list()[0]?.status).toBe('incompatible');
    expect(b.harness.service.state()?.peer?.appVersion).toBe(seen);
    await hostCommand(newer, { name: 'hosts.reconnect', hostId });
    await newer.waitFor(hostId, 'incompatible');
  });

  it('unreachable → retries with growing delays, no loop', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    // A port that takes connections and drops them at once (before TLS).
    const attempts: number[] = [];
    const sockets = new Set<Socket>();
    const dropper = createNetServer((socket) => {
      attempts.push(Date.now());
      sockets.add(socket);
      socket.destroy();
    });
    await new Promise<void>((resolve) => dropper.listen({ host: TEST_HOST, port: 0 }, resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          dropper.close(() => {
            resolve();
          });
        }),
    );
    const { port } = dropper.address() as AddressInfo;
    await hostCommand(a, { name: 'hosts.update', hostId, port });
    const host = await a.waitFor(hostId, 'unreachable');
    expect(host.lastError).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'network' } });
    await sleep(1_600);
    // backoff 100, 200, 400, 800 ms (±20 %): at most 5 attempts in ~1.6 s, the gaps grow
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts.length).toBeLessThanOrEqual(5);
    const gaps = attempts.slice(1).map((at, index) => at - (attempts[index] ?? at));
    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index] ?? 0).toBeGreaterThan(gaps[index - 1] ?? 0);
    }
    // the other computer comes back under its old port
    await hostCommand(a, { name: 'hosts.update', hostId, port: b.port() });
    await a.waitFor(hostId, 'connected');
  });

  it('the other side going away → unreachable', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    await b.close();
    const host = await a.waitFor(hostId, 'unreachable');
    expect(host.lastError?.code).toBe('HOST_UNREACHABLE');
  });

  it('coupling revoked over there → revoked at once, windows end with HOST_REVOKED, no retry', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    const window = await a.service.forwarder.connectWindow(hostId);
    const windowClosed = closedCode(window);
    await b.harness.command({ name: 'remoteAccess.unpair' });
    const host = await a.waitFor(hostId, 'revoked');
    expect(host.lastError).toEqual({ code: 'HOST_REVOKED', params: {} });
    // closed over there with HOST_REVOKED, or by the link when the relay saw it first
    expect(browserCloseCode(window, await windowClosed)).toBe(WS_CLOSE.HOST_REVOKED);
    const refused = await forwarderError(a.service.forwarder.connectWindow(hostId));
    expect(refused.error.code).toBe('HOST_REVOKED');
    expect(a.service.couplings()).toBe(1);
  });

  it('revoked while not connected → confirmed by a second refused attempt', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    await a.service.deactivate();
    expect(a.service.list()).toEqual([]);
    await b.harness.command({ name: 'remoteAccess.unpair' });
    await a.service.activate({ role: 'control', port: 4713, bindAddress: '0.0.0.0' });
    await a.waitFor(hostId, 'revoked');
  });
});

describe('hosts service: forwarder', () => {
  it('opens window connections to the hub, closes them on deactivate and respects the window limit', async () => {
    const b = await sharing();
    const a = await control({ limits: { windows: 1 } });
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    const window = await a.service.forwarder.connectWindow(hostId);
    const hello = await nextMessage(window, 'hello');
    expect(hello).toMatchObject({ type: 'hello', serverVersion: b.version });
    expect(a.service.windowCount(hostId)).toBe(1);
    const limited = await forwarderError(a.service.forwarder.connectWindow(hostId));
    expect(limited.error).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'limit' } });

    const unknown = await forwarderError(a.service.forwarder.connectWindow('pc-z'));
    expect(unknown.error.code).toBe('HOST_NOT_FOUND');
    await expect(
      a.service.forwarder.request(hostId, {
        method: 'GET',
        path: '/remote/v1/health',
        query: '',
        headers: {},
      }),
    ).rejects.toThrow(TypeError);

    const closed = closedCode(window);
    await a.service.deactivate();
    await closed;
    expect(browserCloseCode(window, 1006)).toBe(WS_CLOSE.SERVER_SHUTDOWN);
    expect(a.service.list()).toEqual([]);
    expect(a.service.couplings()).toBe(1);
    const inactive = await forwarderError(a.service.forwarder.connectWindow(hostId));
    expect(inactive.error.code).toBe('HOST_NOT_FOUND');
    await a.service.activate({ role: 'control', port: 4713, bindAddress: '0.0.0.0' });
    await a.waitFor(hostId, 'connected');
  });

  it('forwards a blob request over the pinned agent', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    const blobId = 'b'.repeat(64);
    const response = await a.service.forwarder.request(hostId, {
      method: 'GET',
      path: `/remote/v1/blob/${blobId}`,
      query: '',
      headers: {},
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(response.status).toBe(200);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ blob: blobId });
    expect(b.harness.blobHits).toEqual([blobId]);
  });
});

describe('hosts service: list changes', () => {
  it('update and move change the list; remove asks the other side first (§B.8)', async () => {
    const b1 = await sharing();
    const b2 = await sharing();
    const a = await control();
    const first = await a.add(b1, 'PC B');
    const second = await a.add(b2, 'PC B');
    expect([first, second]).toEqual(['pc-b', 'pc-b-2']);
    await a.waitFor(first, 'connected');
    await a.waitFor(second, 'connected');
    expect(a.service.list().map((host) => [host.hostId, host.color])).toEqual([
      ['pc-b', 'blue'],
      ['pc-b-2', 'green'],
    ]);

    await hostCommand(a, { name: 'hosts.update', hostId: second, displayName: 'Desk', color: 'rose' });
    await hostCommand(a, { name: 'hosts.move', hostId: second, index: 0 });
    expect(a.service.list().map((host) => [host.hostId, host.name, host.color])).toEqual([
      ['pc-b-2', 'Desk', 'rose'],
      ['pc-b', 'PC B', 'blue'],
    ]);
    expect((await hostsFile(a.home)).map((host) => host.hostId)).toEqual(['pc-b-2', 'pc-b']);
    const missing = await rejection(hostCommand(a, { name: 'hosts.update', hostId: 'pc-z', color: 'teal' }));
    expect(missing.error.code).toBe('HOST_NOT_FOUND');

    // remove a revoked one: the other side has no coupling any more – nothing to do there
    await b1.harness.command({ name: 'remoteAccess.unpair' });
    await a.waitFor(first, 'revoked');
    expect(await hostCommand(a, { name: 'hosts.remove', hostId: first })).toEqual({ peerNotified: true });
    // remove the connected one: the other computer drops the coupling
    const window = await a.service.forwarder.connectWindow(second);
    const windowClosed = closedCode(window);
    expect(await hostCommand(a, { name: 'hosts.remove', hostId: second })).toEqual({ peerNotified: true });
    expect(browserCloseCode(window, await windowClosed)).toBe(WS_CLOSE.HOST_REVOKED);
    expect(b2.harness.service.state()?.peer).toBeNull();
    expect(await hostsFile(a.home)).toEqual([]);
    expect(existsSync(keyFilePath(a.home, 'coupling:pc-b-2'))).toBe(false);
    expect(a.service.list()).toEqual([]);
    expect(a.service.couplings()).toBe(0);
  });

  it('remove while the other computer is unreachable → removed here, peerNotified false', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    await b.close();
    await a.waitFor(hostId, 'unreachable');
    expect(await hostCommand(a, { name: 'hosts.remove', hostId })).toEqual({ peerNotified: false });
    expect(await hostsFile(a.home)).toEqual([]);
    expect(a.service.couplings()).toBe(0);
  });
});

describe('hosts service: pairing again', () => {
  it('replaceHostId keeps hostId, color and place; key, kAuth and coupling are new; windows end', async () => {
    const b = await sharing();
    const other = await sharing();
    const a = await control();
    const hostId = await a.add(b, 'PC B');
    await a.add(other, 'PC C');
    await a.waitFor(hostId, 'connected');
    const [before] = await hostsFile(a.home);
    const keyBefore = await readFile(keyFilePath(a.home, 'coupling:pc-b'), 'utf8');
    const window = await a.service.forwarder.connectWindow(hostId);
    const windowClosed = closedCode(window);

    const result = await hostCommand(a, {
      name: 'hosts.add',
      address: TEST_HOST,
      port: b.port(),
      code: await b.code(),
      displayName: 'Desk',
      replaceHostId: hostId,
    });
    expect(result).toEqual({ hostId });
    expect(browserCloseCode(window, await windowClosed)).toBe(WS_CLOSE.HOST_REVOKED);
    await a.waitFor(hostId, 'connected');
    expect(a.service.list().map((host) => [host.hostId, host.name, host.color])).toEqual([
      ['pc-b', 'Desk', 'blue'],
      ['pc-c', 'PC C', 'green'],
    ]);
    const [after] = await hostsFile(a.home);
    expect(after).toMatchObject({
      hostId,
      color: 'blue',
      addedAt: before?.addedAt,
      peerPin: before?.peerPin,
    });
    expect(after?.authKey).not.toBe(before?.authKey);
    expect(await readFile(keyFilePath(a.home, 'coupling:pc-b'), 'utf8')).not.toBe(keyBefore);
    expect(a.service.couplings()).toBe(2);
    expect(b.harness.service.state()?.peer).toMatchObject({ connected: true });
    // the new coupling works for windows
    const fresh = await a.service.forwarder.connectWindow(hostId);
    expect(await nextMessage(fresh, 'hello')).toMatchObject({ type: 'hello' });
  });

  it('the same computer paired again without replaceHostId replaces its entry (no duplicate)', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b, 'PC B');
    await a.waitFor(hostId, 'connected');
    expect(await a.add(b, 'Other name')).toBe(hostId);
    await a.waitFor(hostId, 'connected');
    expect(a.service.list().map((host) => [host.hostId, host.name])).toEqual([['pc-b', 'Other name']]);
    expect(existsSync(keyFilePath(a.home, 'coupling:other-name'))).toBe(false);
    expect(a.service.couplings()).toBe(1);
  });

  it('a failed pairing leaves the entry unchanged; an unknown replaceHostId → HOST_NOT_FOUND', async () => {
    const b = await sharing();
    const a = await control();
    const hostId = await a.add(b);
    await a.waitFor(hostId, 'connected');
    const before = await readFile(path.join(a.home, HOSTS_FILE), 'utf8');
    const keyBefore = await readFile(keyFilePath(a.home, 'coupling:pc-b'), 'utf8');
    await b.code();
    const wrong = await rejection(
      hostCommand(a, {
        name: 'hosts.add',
        address: TEST_HOST,
        port: b.port(),
        code: formatPairingCode(randomBytes(16)),
        displayName: 'Desk',
        replaceHostId: hostId,
      }),
    );
    expect(wrong.error.code).toBe('PAIRING_INVALID');
    expect(await readFile(path.join(a.home, HOSTS_FILE), 'utf8')).toBe(before);
    expect(await readFile(keyFilePath(a.home, 'coupling:pc-b'), 'utf8')).toBe(keyBefore);
    expect(a.service.list()[0]).toMatchObject({ hostId, name: 'PC B', status: 'connected' });

    const unknown = await rejection(
      hostCommand(a, {
        name: 'hosts.add',
        address: TEST_HOST,
        port: b.port(),
        code: await b.code(),
        displayName: 'Desk',
        replaceHostId: 'pc-z',
      }),
    );
    expect(unknown.error).toEqual({ code: 'HOST_NOT_FOUND', params: { hostId: 'pc-z' } });
  });
});
