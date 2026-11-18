import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_PATHS, remotePairRequestSchema } from '@shared/http';
import { formatPairingCode } from '@shared/pairing';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { generateIdentity } from './identity';
import { PairingClientError, pairWithHost } from './pairingClient';
import {
  decodeMac,
  deriveAuthKey,
  encodeMac,
  macEquals,
  pairingKey,
  pairingMac,
  pairingMaterial,
} from './pairingCrypto';
import { TEST_HOST, foreignCredentials, identityCredentials, startTlsServer } from './testKit';

const serverIdentity = generateIdentity('identity');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Behaviour = 'right' | 'wrong-macB' | 'expired' | 'old-version';

/** A minimal sharing side of §B.7 steps 6–7 (the real one is remote/pairing; this checks the client alone). */
async function pairingServer(code: Buffer, behaviour: Behaviour = 'right') {
  const seen = {
    connections: 0,
    requests: 0,
    kAuth: null as Buffer | null,
    macAValid: null as boolean | null,
  };
  const http = createHttpServer((req, res) => {
    seen.requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(body));
      };
      if (behaviour === 'expired') {
        send(401, { code: 'PAIRING_EXPIRED', params: { secretish: 'x'.repeat(100), reason: 'window' } });
        return;
      }
      const parsed = remotePairRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const material = pairingMaterial(req.socket as TLSSocket, 'server');
      const k = pairingKey(code);
      const macA = parsed.success ? decodeMac(parsed.data.macA) : null;
      seen.macAValid = macA !== null && macEquals(pairingMac(k, 'initiator', material.transcript), macA);
      if (!seen.macAValid || req.url !== REMOTE_PATHS.pair || req.method !== 'POST') {
        send(401, { code: 'PAIRING_INVALID', params: {} });
        return;
      }
      seen.kAuth = deriveAuthKey(material.ekmAuth, material.transcript);
      const macB =
        behaviour === 'wrong-macB' ? randomBytes(48) : pairingMac(k, 'responder', material.transcript);
      send(200, {
        macB: encodeMac(macB),
        hostName: 'PC-B',
        appVersion: behaviour === 'old-version' ? '0.9.0' : '1.2.3',
        protocolVersion: PROTOCOL_VERSION,
      });
    });
  });
  const tls = await startTlsServer(
    { ...identityCredentials(serverIdentity), requestCert: true, rejectUnauthorized: false },
    (socket) => {
      seen.connections += 1;
      http.emit('connection', socket);
    },
  );
  cleanups.push(async () => {
    await tls.close();
    http.close();
  });
  return { port: tls.port, seen };
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

function options(port: number, code: string | Uint8Array) {
  return {
    address: TEST_HOST,
    port,
    code,
    deviceName: 'PC-A',
    identity: generateIdentity('coupling:pc-b'),
    appVersion: '1.2.3',
    timeoutMs: 5_000,
  };
}

describe('pairWithHost (§B.7 steps 1–2, 5, 8)', () => {
  it('pairs: macA accepted, macB verified, same kAuth on both ends, pin of the server key', async () => {
    const code = randomBytes(16);
    const server = await pairingServer(code);
    const result = await pairWithHost(
      options(server.port, formatPairingCode(code).toLowerCase().replaceAll('-', ' ')),
    );
    expect(server.seen.macAValid).toBe(true);
    expect(server.seen.kAuth?.equals(result.authKey)).toBe(true);
    expect(result.authKey).toHaveLength(48);
    expect(result.peerPin).toBe(serverIdentity.pin);
    expect(result.peerCertificateDer.equals(serverIdentity.certificateDer)).toBe(true);
    expect(result).toMatchObject({
      hostName: 'PC-B',
      appVersion: '1.2.3',
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('a wrong code is refused by the server (PAIRING_INVALID)', async () => {
    const server = await pairingServer(randomBytes(16));
    const error = await pairingError(pairWithHost(options(server.port, randomBytes(16))));
    expect(error.error.code).toBe('PAIRING_INVALID');
    expect(server.seen.macAValid).toBe(false);
  });

  it('a wrong macB → PAIRING_INVALID and nothing is returned', async () => {
    const code = randomBytes(16);
    const server = await pairingServer(code, 'wrong-macB');
    const error = await pairingError(pairWithHost(options(server.port, code)));
    expect(error.error.code).toBe('PAIRING_INVALID');
    expect(server.seen.macAValid).toBe(true);
  });

  it('passes PAIRING_EXPIRED through with only known short params', async () => {
    const server = await pairingServer(randomBytes(16), 'expired');
    const error = await pairingError(pairWithHost(options(server.port, randomBytes(16))));
    expect(error.error).toEqual({ code: 'PAIRING_EXPIRED', params: { reason: 'window' } });
  });

  it('another version in the (verified) answer → HOST_INCOMPATIBLE', async () => {
    const code = randomBytes(16);
    const server = await pairingServer(code, 'old-version');
    const error = await pairingError(pairWithHost(options(server.port, code)));
    expect(error.error).toEqual({
      code: 'HOST_INCOMPATIBLE',
      params: { version: '0.9.0', protocol: PROTOCOL_VERSION },
    });
  });

  it('a mistyped code fails locally (VALIDATION_FAILED code) without connecting', async () => {
    const code = randomBytes(16);
    const server = await pairingServer(code);
    const typed = formatPairingCode(code);
    const swapped = `${typed.charAt(1)}${typed.charAt(0)}${typed.slice(2)}`;
    const error = await pairingError(pairWithHost(options(server.port, swapped === typed ? 'U' : swapped)));
    expect(error.error).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'code' } });
    expect(server.seen.connections).toBe(0);
  });

  it('a closed port → HOST_UNREACHABLE refused', async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen({ host: TEST_HOST, port: 0 }, resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) =>
      probe.close(() => {
        resolve();
      }),
    );
    const error = await pairingError(pairWithHost(options(port, randomBytes(16))));
    expect(error.error).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'refused' } });
  });

  it('a server with an Ed25519 certificate → HOST_UNREACHABLE (no fallback)', async () => {
    const ed = foreignCredentials('ed25519');
    const tls = await startTlsServer(
      { key: ed.key, cert: ed.cert, sigalgs: 'ed25519', requestCert: true, rejectUnauthorized: false },
      () => undefined,
    );
    cleanups.push(() => tls.close());
    const error = await pairingError(pairWithHost(options(tls.port, randomBytes(16))));
    expect(error.error.code).toBe('HOST_UNREACHABLE');
  });
});
