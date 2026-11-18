import { randomBytes } from 'node:crypto';
import { connect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePairingCode } from '@shared/pairing';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { generateIdentity } from '../secure/identity';
import { PairingClientError } from '../secure/pairingClient';
import { TEST_HOST, identityCredentials, startTlsServer } from '../secure/testKit';
import { TLS_PROFILE } from '../secure/tlsProfile';
import { OPEN_LIMITS, pairBody, pairingSocket, rawRequest, startHarness, type Harness } from './testKit';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

async function openWindow(h: Harness): Promise<Uint8Array> {
  const opened = (await h.command({ name: 'remoteAccess.pair' })) as { code: string };
  const bytes = parsePairingCode(opened.code);
  if (bytes === null) throw new Error('bad code');
  return bytes;
}

async function pairingError(promise: Promise<unknown>): Promise<PairingClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingClientError) return error;
    throw error;
  }
  throw new Error('expected a PairingClientError');
}

/** Waits until the sharing side classified `count` pairing sockets (the client's secureConnect can come first). */
async function classified(h: Harness, count: number): Promise<void> {
  await expect.poll(() => h.service.connectionCounts().pairing).toBe(count);
}

async function kinds(h: Harness, onlyRejected = false): Promise<string[]> {
  const result = (await h.command({ name: 'remoteAccess.events', onlyRejected })) as {
    events: { kind: string }[];
  };
  return result.events.map((event) => event.kind);
}

describe('pairing on the sharing side (§B.7)', () => {
  it('a wrong code counts; after 3 failures the window is closed and new keys are refused at TLS', async () => {
    const h = await harness();
    const code = await openWindow(h);
    for (let i = 0; i < 3; i += 1) {
      const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-x'));
      const answer = await rawRequest(socket, { body: pairBody(socket, randomBytes(16)) });
      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toEqual({ code: 'PAIRING_INVALID', params: {} });
      expect(h.service.state()?.pairingExpiresAt === null).toBe(i === 2);
    }
    // The right code no longer helps: no window → the unknown key is refused right after TLS.
    const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-y')).catch(() => null);
    if (socket !== null) {
      const answer = await rawRequest(socket, { body: pairBody(socket, code) });
      expect(answer.status).toBe(0);
    }
    expect(h.service.state()?.peer).toBeNull();
    expect(await kinds(h, true)).toContain('unknown_key');
    expect((await kinds(h, true)).filter((kind) => kind === 'pair_failed').length).toBeGreaterThan(0);
  });

  it('the right code pairs exactly once; a second connection of the same window gets nothing', async () => {
    const h = await harness();
    const code = await openWindow(h);
    const second = await pairingSocket(h.port(), generateIdentity('coupling:pc-z'));
    const first = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    await classified(h, 2);
    const secondClosed = new Promise<void>((resolve) =>
      second.once('close', () => {
        resolve();
      }),
    );
    const ok = await rawRequest(first, { body: pairBody(first, code) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      hostName: 'PC-B',
      appVersion: '1.2.3',
      protocolVersion: PROTOCOL_VERSION,
    });
    // The window is used up: its other sockets are closed, they never get an answer.
    await secondClosed;
    expect((await rawRequest(second, { body: '{}' })).status).toBe(0);
    expect(h.service.state()?.peer?.name).toBe('PC-A');
  });

  it('expired between connection and request → PAIRING_EXPIRED', async () => {
    let clock = Date.parse('2026-11-18T10:00:00.000Z');
    const h = await harness({ now: () => new Date(clock) });
    const code = await openWindow(h);
    const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    await classified(h, 1);
    clock += 10 * 60_000;
    const answer = await rawRequest(socket, { body: pairBody(socket, code) });
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ code: 'PAIRING_EXPIRED', params: {} });
    expect(h.service.state()?.pairingExpiresAt).toBeNull();
    expect(await kinds(h)).toContain('pair_expired');
  });

  it('a socket of a replaced window is closed', async () => {
    const h = await harness();
    await openWindow(h);
    const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    await classified(h, 1);
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        resolve();
      }),
    );
    await openWindow(h);
    await closed;
    expect((await rawRequest(socket, { body: '{}' })).status).toBe(0);
    expect(h.service.state()?.peer).toBeNull();
  });

  it('a relay in the middle (two TLS connections) → PAIRING_INVALID, nothing stored', async () => {
    const h = await harness();
    const code = await openWindow(h);
    // The relay presents its own key to the client and its own client key to the sharing side.
    const relayIdentity = generateIdentity('identity');
    const relayClient = generateIdentity('coupling:relay');
    const relay = await startTlsServer(
      { ...identityCredentials(relayIdentity), requestCert: true, rejectUnauthorized: false },
      (inbound: TLSSocket) => {
        const outbound = connect({
          ...TLS_PROFILE,
          ...identityCredentials(relayClient),
          host: TEST_HOST,
          port: h.port(),
          servername: '',
          rejectUnauthorized: false,
        });
        inbound.pipe(outbound);
        outbound.pipe(inbound);
        inbound.on('error', () => outbound.destroy());
        outbound.on('error', () => inbound.destroy());
      },
    );
    cleanups.push(() => relay.close());
    const error = await pairingError(h.pairTo(relay.port, code));
    expect(error.error.code).toBe('PAIRING_INVALID');
    expect(h.service.state()?.peer).toBeNull();
  });

  it('a recorded body replayed on a new connection → PAIRING_INVALID', async () => {
    const h = await harness();
    const code = await openWindow(h);
    const identity = generateIdentity('coupling:pc-a');
    const recorded = await pairingSocket(h.port(), identity);
    const body = pairBody(recorded, code);
    recorded.destroy();
    const replay = await pairingSocket(h.port(), identity);
    const answer = await rawRequest(replay, { body });
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ code: 'PAIRING_INVALID', params: {} });
    expect(h.service.state()?.peer).toBeNull();
  });

  it('a pairing socket that sends nothing ends after pairingSocketMs (no listen() timeouts needed)', async () => {
    const h = await harness({ limits: { ...OPEN_LIMITS, pairingIdleMs: 60_000, pairingSocketMs: 300 } });
    await openWindow(h);
    const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    await classified(h, 1);
    const started = Date.now();
    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await classified(h, 0);
    expect(h.service.state()?.pairingExpiresAt).not.toBeNull();
  });

  it('rate limit per address → PAIRING_RATE_LIMITED (no failed attempt counted)', async () => {
    const h = await harness({ limits: { ...OPEN_LIMITS, pairingPerAddressPerMinute: 1 } });
    const code = await openWindow(h);
    const first = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    expect((await rawRequest(first, { body: '{}' })).status).toBe(401);
    const second = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    const answer = await rawRequest(second, { body: pairBody(second, code) });
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.body)).toMatchObject({ code: 'PAIRING_RATE_LIMITED' });
    expect(h.service.state()?.pairingExpiresAt).not.toBeNull();
    expect(await kinds(h)).toContain('pair_rate_limited');
  });

  it('another version with the right code → HOST_INCOMPATIBLE, nothing stored, code used up', async () => {
    const h = await harness();
    const code = await openWindow(h);
    const socket = await pairingSocket(h.port(), generateIdentity('coupling:pc-a'));
    const answer = await rawRequest(socket, {
      body: pairBody(socket, code),
      headers: { 'parallax-version': '2.0.0' },
    });
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toEqual({
      code: 'HOST_INCOMPATIBLE',
      params: { version: '1.2.3', protocol: PROTOCOL_VERSION },
    });
    expect(h.service.state()?.peer).toBeNull();
    expect(h.service.state()?.pairingExpiresAt).toBeNull();
  });

  it('browser headers, other paths, other methods and oversized bodies are refused', async () => {
    const h = await harness();
    const code = await openWindow(h);
    const identity = generateIdentity('coupling:pc-a');
    let socket = await pairingSocket(h.port(), identity);
    expect(
      (await rawRequest(socket, { body: pairBody(socket, code), headers: { origin: 'https://x.example' } }))
        .status,
    ).toBe(403);
    socket = await pairingSocket(h.port(), identity);
    expect((await rawRequest(socket, { method: 'GET', path: '/remote/v1/pair' })).status).toBe(404);
    socket = await pairingSocket(h.port(), identity);
    expect((await rawRequest(socket, { path: '/remote/v1/health' })).status).toBe(404);
    socket = await pairingSocket(h.port(), identity);
    const big = JSON.stringify({ deviceName: 'PC-A', macA: 'A'.repeat(64), pad: 'x'.repeat(5000) });
    expect((await rawRequest(socket, { body: big })).status).toBe(413);
    // None of these counted as a failed attempt or stored anything.
    expect(h.service.state()?.peer).toBeNull();
    expect(h.service.state()?.pairingExpiresAt).not.toBeNull();
  });

  it('at most 4 pairing sockets at a time', async () => {
    const h = await harness();
    await openWindow(h);
    const sockets = await Promise.all(
      [0, 1, 2, 3].map(() => pairingSocket(h.port(), generateIdentity('coupling:pc-a'))),
    );
    await classified(h, 4);
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
    });
    const fifth = await pairingSocket(h.port(), generateIdentity('coupling:pc-a')).catch(() => null);
    if (fifth !== null) expect((await rawRequest(fifth, { body: '{}' })).status).toBe(0);
    expect(await kinds(h, true)).toContain('pair_rate_limited');
  });
});
