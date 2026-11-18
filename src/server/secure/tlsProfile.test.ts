import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateIdentity } from './identity';
import { foreignCredentials, identityCredentials, startTlsServer, tryConnect } from './testKit';
import {
  EXPORTER_LABELS,
  TLS_CIPHER,
  TLS_GROUP,
  TLS_PROFILE,
  TLS_VERSION,
  exportKeyingMaterial,
  profileViolation,
} from './tlsProfile';

const server = generateIdentity('identity');
const client = generateIdentity('coupling:pc-a');
let tls: Awaited<ReturnType<typeof startTlsServer>>;
const accepted: TLSSocket[] = [];

beforeAll(async () => {
  tls = await startTlsServer(
    {
      ...identityCredentials(server),
      requestCert: true,
      rejectUnauthorized: false,
      handshakeTimeout: 10_000,
    },
    (socket) => {
      accepted.push(socket);
    },
  );
});

afterAll(async () => {
  await tls.close();
});

/** Client options of the profile, pinned to the server certificate. */
function profileClient(overrides: Record<string, unknown> = {}) {
  return {
    ...TLS_PROFILE,
    ...identityCredentials(client),
    port: tls.port,
    ca: [server.certificatePem],
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
    ...overrides,
  };
}

describe('TLS profile against a real handshake (§B.3, §B.12 "Parameter")', () => {
  it('negotiates exactly TLS 1.3, TLS_AES_256_GCM_SHA384, SecP384r1MLKEM1024 with ML-DSA-87 on both ends', async () => {
    const result = await tryConnect(profileClient());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const socket = result.socket;
    expect(socket.authorized).toBe(true);
    expect(socket.getProtocol()).toBe(TLS_VERSION);
    expect(socket.getCipher().name).toBe(TLS_CIPHER);
    expect(socket.getEphemeralKeyInfo()).toMatchObject({ type: 'TLSGroup', name: TLS_GROUP });
    expect(socket.getPeerX509Certificate()?.publicKey.asymmetricKeyType).toBe('ml-dsa-87');
    expect(socket.isSessionReused()).toBe(false);
    expect(profileViolation(socket, 'client')).toBeNull();
    await expect.poll(() => accepted.length).toBeGreaterThan(0);
    const serverSide = accepted.at(-1);
    expect(serverSide?.getPeerX509Certificate()?.publicKey.asymmetricKeyType).toBe('ml-dsa-87');
    expect(serverSide === undefined ? 'missing' : profileViolation(serverSide, 'server')).toBeNull();
    // Same exporter on both ends, different per label.
    if (serverSide !== undefined) {
      expect(exportKeyingMaterial(socket, 'conn').equals(exportKeyingMaterial(serverSide, 'conn'))).toBe(
        true,
      );
      expect(exportKeyingMaterial(socket, 'pair').equals(exportKeyingMaterial(socket, 'conn'))).toBe(false);
    }
    expect(Object.values(EXPORTER_LABELS).every((label) => label.startsWith('EXPERIMENTAL-'))).toBe(true);
    socket.destroy();
  });

  it.each([
    ['TLS 1.2', { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384' }],
    ['TLS_AES_128_GCM_SHA256', { ciphers: 'TLS_AES_128_GCM_SHA256' }],
    ['TLS_CHACHA20_POLY1305_SHA256', { ciphers: 'TLS_CHACHA20_POLY1305_SHA256' }],
    ['X25519 only', { ecdhCurve: 'X25519' }],
    ['X25519MLKEM768 only', { ecdhCurve: 'X25519MLKEM768' }],
    ['P-384 only (no ML-KEM)', { ecdhCurve: 'P-384' }],
    ['Ed25519 signatures only', { sigalgs: 'ed25519' }],
  ])('refuses a client offering %s', async (_label, overrides) => {
    const result = await tryConnect(profileClient(overrides));
    expect(result.ok).toBe(false);
  });

  it('a profile client refuses a server with an Ed25519 certificate', async () => {
    const ed = foreignCredentials('ed25519');
    const edServer = await startTlsServer(
      { key: ed.key, cert: ed.cert, sigalgs: 'ed25519' },
      () => undefined,
    );
    try {
      const result = await tryConnect(profileClient({ port: edServer.port, ca: [ed.cert] }));
      expect(result.ok).toBe(false);
    } finally {
      await edServer.close();
    }
  });

  it('never resumes: an offered old session is not reused', async () => {
    // OpenSSL still sends stateful TLS 1.3 tickets with SSL_OP_NO_TICKET, but Node's server cache
    // stores nothing without newSession/resumeSession handlers – the offer always falls back.
    const tickets: unknown[] = [];
    const first = await tryConnect(profileClient());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.socket.on('session', (session) => tickets.push(session));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const offered = first.socket.getSession() ?? (tickets[0] as Buffer | undefined);
    first.socket.destroy();
    const second = await tryConnect(profileClient(offered === undefined ? {} : { session: offered }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.socket.isSessionReused()).toBe(false);
    second.socket.destroy();
  });

  it('profileViolation fails closed for a resumed or broken socket', () => {
    const reused = { isSessionReused: () => true } as unknown as TLSSocket;
    expect(profileViolation(reused, 'server')).toBe('reused');
    const throwing = {
      isSessionReused: () => {
        throw new Error('boom');
      },
    } as unknown as TLSSocket;
    expect(profileViolation(throwing, 'client')).toBe('check_failed');
  });
});
