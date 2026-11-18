import { randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROOF_BYTES,
  connectionTranscript,
  proofMatches,
  proofMessage,
  proveAsClient,
  proveAsServer,
  type ProofFailure,
} from './connectionProof';
import { generateIdentity } from './identity';
import { identityCredentials, startTlsServer, tryConnect } from './testKit';
import { TLS_PROFILE } from './tlsProfile';

const serverIdentity = generateIdentity('identity');
const clientIdentity = generateIdentity('coupling:pc-b');
const kAuth = randomBytes(48);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A server that runs proveAsServer (timeout `ms`) and records the outcome. */
async function proofServer(ms = 2_000) {
  const results: (ProofFailure | null)[] = [];
  const sockets: TLSSocket[] = [];
  const tls = await startTlsServer(
    { ...identityCredentials(serverIdentity), requestCert: true, rejectUnauthorized: false },
    (socket) => {
      sockets.push(socket);
      void proveAsServer(socket, kAuth, ms).then((result) => {
        results.push(result);
        if (result !== null) socket.destroy();
      });
    },
  );
  cleanups.push(() => tls.close());
  return { ...tls, results, sockets };
}

async function connectClient(port: number): Promise<TLSSocket> {
  const result = await tryConnect({
    ...TLS_PROFILE,
    ...identityCredentials(clientIdentity),
    port,
    ca: [serverIdentity.certificatePem],
    checkServerIdentity: () => undefined,
  });
  if (!result.ok) throw result.error;
  cleanups.push(() => {
    result.socket.destroy();
  });
  return result.socket;
}

describe('connection proof (§B.9)', () => {
  it('both ends prove kAuth; the messages are 52 bytes with PXC1/PXS1', async () => {
    const server = await proofServer();
    const socket = await connectClient(server.port);
    expect(await proveAsClient(socket, kAuth)).toBeNull();
    await expect.poll(() => server.results).toEqual([null]);
    const transcript = connectionTranscript(socket, 'client');
    const message = proofMessage(kAuth, 'initiator', transcript);
    expect(message).toHaveLength(PROOF_BYTES);
    expect(message.subarray(0, 4).toString()).toBe('PXC1');
    expect(proofMessage(kAuth, 'responder', transcript).subarray(0, 4).toString()).toBe('PXS1');
    // Both ends compute the same Tc from the socket.
    const serverSide = server.sockets[0];
    expect(
      serverSide === undefined ? null : connectionTranscript(serverSide, 'server').equals(transcript),
    ).toBe(true);
  });

  it('a wrong secret is refused by the server (mismatch)', async () => {
    const server = await proofServer();
    const socket = await connectClient(server.port);
    expect(await proveAsClient(socket, randomBytes(48))).not.toBeNull();
    await expect.poll(() => server.results).toEqual(['mismatch']);
  });

  it('more than 52 bytes before the answer → refused (excess)', async () => {
    const server = await proofServer();
    const socket = await connectClient(server.port);
    const transcript = connectionTranscript(socket, 'client');
    socket.write(
      Buffer.concat([proofMessage(kAuth, 'initiator', transcript), Buffer.from('GET / HTTP/1.1\r\n\r\n')]),
    );
    await expect.poll(() => server.results).toEqual(['excess']);
  });

  it('nothing within the time limit → refused (timeout)', async () => {
    const server = await proofServer(150);
    await connectClient(server.port);
    await expect.poll(() => server.results).toEqual(['timeout']);
  });

  it('a reflected client proof is not a server proof (role labels)', () => {
    const transcript = randomBytes(200);
    const client = proofMessage(kAuth, 'initiator', transcript);
    expect(proofMatches(client, kAuth, 'initiator', transcript)).toBe(true);
    expect(proofMatches(client, kAuth, 'responder', transcript)).toBe(false);
    const asServerTag = Buffer.concat([Buffer.from('PXS1'), client.subarray(4)]);
    expect(proofMatches(asServerTag, kAuth, 'responder', transcript)).toBe(false);
    expect(proofMatches(client.subarray(0, 51), kAuth, 'initiator', transcript)).toBe(false);
  });
});
