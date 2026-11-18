/**
 * TLS self-test of the check `tls` (docs/wp/WP-76.md §B.11): ML-DSA-87 sign/verify (a flipped bit of
 * the signature or the message must fail) and a mutual handshake with the §B.3 profile against
 * itself over loopback (127.0.0.1, port 0), checking protocol, suite, group, the peer certificates
 * and that both exporters agree. A machine without ML-KEM/ML-DSA fails here → REMOTE_ACCESS_FAILED
 * {reason:'tls_unsupported'} (no fallback).
 */
import { createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { generateIdentity } from './identity';
import { bytesEqual, pinOfCertificate, pinsEqual } from './pins';
import type { Identity } from './ports';
import {
  HANDSHAKE_TIMEOUT_MS,
  TLS_PROFILE,
  exportKeyingMaterial,
  privateKeyPem,
  profileViolation,
} from './tlsProfile';

export type SelfTestFailure = 'keys' | 'signature' | 'handshake';

function signatureWorks(identity: Identity): boolean {
  const message = randomBytes(64);
  const publicKey = createPublicKey(identity.privateKey);
  const signature = sign(null, message, identity.privateKey);
  if (!verify(null, message, publicKey, signature)) return false;
  const badSignature = Buffer.from(signature);
  badSignature[0] = (badSignature[0] ?? 0) ^ 0x01;
  if (verify(null, message, publicKey, badSignature)) return false;
  const badMessage = Buffer.from(message);
  badMessage[10] = (badMessage[10] ?? 0) ^ 0x80;
  return !verify(null, badMessage, publicKey, signature);
}

function handshakeWorks(server: Identity, client: Identity, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const serverKey = privateKeyPem(server);
    const clientKey = privateKeyPem(client);
    let done = false;
    let serverSide: TLSSocket | null = null;
    let clientSide: TLSSocket | null = null;
    const tlsServer = createServer({
      ...TLS_PROFILE,
      key: serverKey,
      cert: server.certificatePem,
      requestCert: true,
      rejectUnauthorized: false,
      handshakeTimeout: timeoutMs,
    });
    serverKey.fill(0);
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clientSide?.destroy();
      serverSide?.destroy();
      tlsServer.close();
      resolve(ok);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    let serverEkm: Buffer | null = null;
    let clientEkm: Buffer | null = null;
    const compare = (): void => {
      if (serverEkm === null || clientEkm === null) return;
      finish(bytesEqual(serverEkm, clientEkm));
    };
    tlsServer.on('secureConnection', (socket) => {
      serverSide = socket;
      socket.on('error', () => undefined);
      try {
        const peer = socket.getPeerX509Certificate();
        if (
          profileViolation(socket, 'server') !== null ||
          peer === undefined ||
          !pinsEqual(pinOfCertificate(peer.raw), client.pin)
        ) {
          finish(false);
          return;
        }
        serverEkm = exportKeyingMaterial(socket, 'conn');
        compare();
      } catch {
        finish(false);
      }
    });
    tlsServer.on('tlsClientError', () => {
      finish(false);
    });
    tlsServer.on('error', () => {
      finish(false);
    });
    tlsServer.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = tlsServer.address() as AddressInfo;
      const socket = connect({
        ...TLS_PROFILE,
        host: '127.0.0.1',
        port,
        key: clientKey,
        cert: client.certificatePem,
        ca: [server.certificatePem],
        servername: '',
        rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) => {
          try {
            return pinsEqual(pinOfCertificate(cert.raw), server.pin) ? undefined : new Error('pin');
          } catch {
            return new Error('pin');
          }
        },
      });
      clientKey.fill(0);
      clientSide = socket;
      socket.on('error', () => {
        finish(false);
      });
      socket.once('secureConnect', () => {
        try {
          if (!socket.authorized || profileViolation(socket, 'client') !== null) {
            finish(false);
            return;
          }
          clientEkm = exportKeyingMaterial(socket, 'conn');
          compare();
        } catch {
          finish(false);
        }
      });
    });
  });
}

/** Null = everything works; otherwise the first failing part. Never throws. */
export async function tlsSelfTest(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<SelfTestFailure | null> {
  let server: Identity;
  let client: Identity;
  try {
    server = generateIdentity('identity');
    client = generateIdentity('coupling:self-test');
  } catch {
    return 'keys';
  }
  try {
    if (!signatureWorks(server)) return 'signature';
  } catch {
    return 'signature';
  }
  try {
    return (await handshakeWorks(server, client, timeoutMs)) ? null : 'handshake';
  } catch {
    return 'handshake';
  }
}
