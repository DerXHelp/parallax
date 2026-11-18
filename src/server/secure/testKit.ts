/**
 * Test helpers for "Several computers" (secure/, remote/, and WP-79's host tests). Not used by
 * production code. Every server binds 127.0.0.1 with port 0 (never 0.0.0.0 – no firewall prompt).
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  connect,
  createServer,
  type ConnectionOptions,
  type Server,
  type TLSSocket,
  type TlsOptions,
} from 'node:tls';
import { objectIdentifier, randomSerial, sequence, tlv, unsignedInteger } from './der';
import { certificatePem } from './pins';
import type { Identity } from './ports';
import { TLS_PROFILE, privateKeyPem } from './tlsProfile';

export const TEST_HOST = '127.0.0.1';

/** OIDs of foreign key types for negative tests. */
export const FOREIGN_KEY_OIDS = {
  ed25519: '1.3.101.112',
  'ml-dsa-65': '2.16.840.1.101.3.4.3.18',
  'ml-dsa-87': '2.16.840.1.101.3.4.3.19',
} as const;
export type ForeignKeyType = keyof typeof FOREIGN_KEY_OIDS;

/** A self-signed certificate like §B.4 for any of the key types above (or a given name). */
export function buildTestCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  type: ForeignKeyType,
  commonName = 'parallax',
): Buffer {
  const algorithm = sequence(objectIdentifier(FOREIGN_KEY_OIDS[type]));
  const name = sequence(
    tlv(0x31, sequence(objectIdentifier('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))),
  );
  const validity = sequence(
    tlv(0x17, Buffer.from('000101000000Z')),
    tlv(0x18, Buffer.from('99991231235959Z')),
  );
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(randomSerial()),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  return sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), sign(null, tbs, privateKey)));
}

/** Key PEM + certificate PEM for TLS options of a foreign key type (negative tests). */
export function foreignCredentials(type: ForeignKeyType): { key: string; cert: string; der: Buffer } {
  const { privateKey, publicKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync(type === 'ml-dsa-65' ? 'ml-dsa-65' : 'ml-dsa-87');
  const der = buildTestCertificate(privateKey, publicKey, type);
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: certificatePem(der),
    der,
  };
}

/** TLS client credentials of an identity (key PEM as string – tests only). */
export function identityCredentials(identity: Identity): { key: string; cert: string } {
  return { key: privateKeyPem(identity).toString('utf8'), cert: identity.certificatePem };
}

/** A TLS server with the §B.3 profile (or overrides) on 127.0.0.1:0. */
export async function startTlsServer(
  options: TlsOptions,
  onSecure: (socket: TLSSocket) => void,
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer({ ...TLS_PROFILE, ...options }, onSecure);
  const sockets = new Set<TLSSocket>();
  server.on('secureConnection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen({ host: TEST_HOST, port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Connects with the given options; resolves with the socket after `secureConnect` or with the error
 * (handshake failures are results, not exceptions).
 */
export function tryConnect(
  options: ConnectionOptions,
  timeoutMs = 5_000,
): Promise<{ ok: true; socket: TLSSocket } | { ok: false; error: Error }> {
  return new Promise((resolve) => {
    let done = false;
    const socket = connect({ host: TEST_HOST, servername: '', ...options });
    const finish = (result: { ok: true; socket: TLSSocket } | { ok: false; error: Error }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!result.ok) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error('timeout') });
    }, timeoutMs);
    socket.once('secureConnect', () => {
      finish({ ok: true, socket });
    });
    socket.on('error', (error: Error) => {
      finish({ ok: false, error });
    });
    socket.once('close', () => {
      finish({ ok: false, error: new Error('closed') });
    });
  });
}

/** Resolves when the socket closed (or at once if it already is). */
export function closed(socket: TLSSocket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) =>
    socket.once('close', () => {
      resolve();
    }),
  );
}
