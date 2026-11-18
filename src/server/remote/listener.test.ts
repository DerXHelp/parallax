import { randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentity } from '../secure/identity';
import { foreignCredentials, identityCredentials, TEST_HOST } from '../secure/testKit';
import { OPEN_LIMITS, rawExchange, startHarness, type Harness } from './testKit';

const harnesses: Harness[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

async function kinds(h: Harness): Promise<string[]> {
  const result = (await h.command({ name: 'remoteAccess.events', onlyRejected: true })) as {
    events: { kind: string }[];
  };
  return result.events.map((event) => event.kind);
}

const EARLY_REQUEST =
  'GET /remote/v1/blob/early HTTP/1.1\r\nhost: x\r\nparallax-version: 1.2.3\r\nparallax-protocol: 5\r\n\r\n';

function tcp(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: TEST_HOST, port }, () => {
      resolve(socket);
    });
    socket.on('error', reject);
    sockets.push(socket);
  });
}

function closedWithin(socket: Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('listener: classification before HTTP (§B.6, §B.12)', () => {
  it('an unknown key → closed, 0 requests reach a handler (request in the same flight as Finished)', async () => {
    const h = await harness();
    await h.pair();
    const result = await rawExchange(
      h.port(),
      identityCredentials(generateIdentity('coupling:other')),
      EARLY_REQUEST,
    );
    expect(result.received.toString('utf8')).not.toContain('HTTP/1.1');
    expect(h.blobHits).toEqual([]);
    expect(await kinds(h)).toContain('unknown_key');
  });

  it('no certificate, Ed25519 or ML-DSA-65 → closed and bad_certificate, also while a pairing window is open', async () => {
    const h = await harness();
    await h.command({ name: 'remoteAccess.pair' });
    const ed = foreignCredentials('ed25519');
    const ml65 = foreignCredentials('ml-dsa-65');
    const attempts = [
      await rawExchange(h.port(), null, EARLY_REQUEST),
      await rawExchange(h.port(), { key: ed.key, cert: ed.cert, sigalgs: 'mldsa87:ed25519' }, EARLY_REQUEST),
      await rawExchange(
        h.port(),
        { key: ml65.key, cert: ml65.cert, sigalgs: 'mldsa87:mldsa65' },
        EARLY_REQUEST,
      ),
    ];
    for (const attempt of attempts) expect(attempt.received.toString('utf8')).not.toContain('HTTP/1.1');
    expect(h.blobHits).toEqual([]);
    expect(h.service.connectionCounts().pairing).toBe(0);
    // The handshake completes without a usable certificate (OpenSSL sends none when its key does not
    // fit the server's mldsa87-only list); the classification refuses all three (one merged row).
    expect(attempts[0]?.secured).toBe(true);
    const events = (await h.command({ name: 'remoteAccess.events', onlyRejected: true })) as {
      events: { kind: string; count: number }[];
    };
    expect(events.events.find((event) => event.kind === 'bad_certificate')?.count).toBe(3);
    expect(events.events.map((event) => event.kind)).not.toContain('pair_failed');
  });

  it('the pin of the coupling with a wrong connection proof → 0 requests, proof_failed', async () => {
    const h = await harness();
    const paired = await h.pair();
    const wrongProof = Buffer.concat([Buffer.from('PXC1'), randomBytes(48), Buffer.from(EARLY_REQUEST)]);
    const result = await rawExchange(h.port(), identityCredentials(paired.identity), wrongProof);
    expect(result.secured).toBe(true);
    expect(result.received.length).toBe(0);
    expect(h.blobHits).toEqual([]);
    expect(await kinds(h)).toContain('proof_failed');
  });

  it('the pin of the coupling and HTTP without a proof → 0 requests', async () => {
    const h = await harness();
    const paired = await h.pair();
    const result = await rawExchange(h.port(), identityCredentials(paired.identity), EARLY_REQUEST.repeat(2));
    expect(result.received.length).toBe(0);
    expect(h.blobHits).toEqual([]);
  });
});

describe('listener: limits before TLS (§B.10)', () => {
  it('the fifth concurrent connection of an address is destroyed (rate_limited)', async () => {
    const h = await harness({ limits: { ...OPEN_LIMITS, perAddressConcurrent: 4 } });
    const open = await Promise.all([0, 1, 2, 3].map(() => tcp(h.port())));
    const fifth = await tcp(h.port());
    expect(await closedWithin(fifth, 2_000)).toBe(true);
    for (const socket of open) expect(socket.destroyed).toBe(false);
    expect(await kinds(h)).toContain('rate_limited');
  });

  it('the token bucket per address stops bursts', async () => {
    const h = await harness({ limits: { ...OPEN_LIMITS, perAddressBurst: 2, perAddressPerMinute: 1 } });
    const first = await tcp(h.port());
    const second = await tcp(h.port());
    const third = await tcp(h.port());
    expect(await closedWithin(third, 2_000)).toBe(true);
    expect(first.destroyed || second.destroyed).toBe(false);
  });

  it('the handshake timeout ends silent connections (tls_failed)', async () => {
    const h = await harness({ limits: { ...OPEN_LIMITS, handshakeTimeoutMs: 200 } });
    const silent = await tcp(h.port());
    expect(await closedWithin(silent, 3_000)).toBe(true);
    await expect.poll(() => kinds(h)).toContain('tls_failed');
  });

  it('garbage instead of a ClientHello → closed, tls_failed', async () => {
    const h = await harness();
    const socket = await tcp(h.port());
    socket.write('GET / HTTP/1.1\r\nhost: x\r\n\r\n');
    expect(await closedWithin(socket, 3_000)).toBe(true);
    await expect.poll(() => kinds(h)).toContain('tls_failed');
  });
});
