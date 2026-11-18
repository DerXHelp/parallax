import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PROOF_BYTES, proveAsServer, readExactly, type ProofFailure } from './connectionProof';
import { generateIdentity } from './identity';
import {
  PinnedAgent,
  PinnedConnectionError,
  REMOTE_WS_CLIENT_OPTIONS,
  remoteVersionHeaders,
} from './pinnedAgent';
import type { Identity } from './ports';
import { TEST_HOST, identityCredentials, startTlsServer } from './testKit';

const serverIdentity = generateIdentity('identity');
const clientIdentity = generateIdentity('coupling:pc-b');
const kAuth = randomBytes(48);

interface PeerServer {
  port: number;
  requests: string[];
  proofs: (ProofFailure | null)[];
  tlsErrors: number;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A minimal sharing side: §B.3 TLS, connection proof, then an HTTP server (and `ws`) on the same
 * socket. `serverProof: 'wrong'` answers with a random proof instead of the right one.
 */
async function startPeerServer(
  options: { identity?: Identity; key?: Buffer; serverProof?: 'right' | 'wrong' } = {},
): Promise<PeerServer> {
  const requests: string[] = [];
  const proofs: (ProofFailure | null)[] = [];
  const http = createHttpServer((req: IncomingMessage, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''} ${String(req.headers['parallax-version'] ?? '-')}`);
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    requests.push(`UPGRADE ${req.url ?? ''}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data: Buffer) => {
        ws.send(`echo:${data.toString()}`);
      });
    });
  });
  const state = { tlsErrors: 0 };
  const tls = await startTlsServer(
    {
      ...identityCredentials(options.identity ?? serverIdentity),
      requestCert: true,
      rejectUnauthorized: false,
    },
    (socket: TLSSocket) => {
      if (options.serverProof === 'wrong') {
        void readExactly(socket, PROOF_BYTES, 5_000).then((read) => {
          if (!read.ok) return;
          socket.write(Buffer.concat([Buffer.from('PXS1'), randomBytes(48)]));
          http.emit('connection', socket);
        });
        return;
      }
      void proveAsServer(socket, options.key ?? kAuth).then((failure) => {
        proofs.push(failure);
        if (failure !== null) {
          socket.destroy();
          return;
        }
        http.emit('connection', socket);
      });
    },
  );
  tls.server.on('tlsClientError', () => {
    state.tlsErrors += 1;
  });
  const server: PeerServer = {
    port: tls.port,
    requests,
    proofs,
    get tlsErrors() {
      return state.tlsErrors;
    },
    close: async () => {
      wss.close();
      await tls.close();
      http.close();
    },
  };
  cleanups.push(() => server.close());
  return server;
}

function makeAgent(overrides: Partial<ConstructorParameters<typeof PinnedAgent>[0]> = {}): PinnedAgent {
  const agent = new PinnedAgent({
    identity: clientIdentity,
    peerCertificateDer: serverIdentity.certificateDer,
    peerPin: serverIdentity.pin,
    authKey: kAuth,
    connectTimeoutMs: 3_000,
    proofTimeoutMs: 3_000,
    ...overrides,
  });
  cleanups.push(() => {
    agent.destroy();
  });
  return agent;
}

function get(
  agent: PinnedAgent,
  port: number,
  path = '/remote/v1/health',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: TEST_HOST, port, path, agent, headers: remoteVersionHeaders('1.2.3') },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function refused(promise: Promise<unknown>): Promise<PinnedConnectionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PinnedConnectionError) return error;
    throw error;
  }
  throw new Error('expected a refused connection');
}

describe('PinnedAgent (§B.6 client, §B.9 proof)', () => {
  it('carries HTTP with keep-alive after handshake, pin and proof', async () => {
    const server = await startPeerServer();
    const agent = makeAgent();
    expect(await get(agent, server.port)).toEqual({ status: 200, body: 'ok' });
    expect(await get(agent, server.port, '/remote/v1/file')).toEqual({ status: 200, body: 'ok' });
    expect(server.requests).toEqual(['GET /remote/v1/health 1.2.3', 'GET /remote/v1/file 1.2.3']);
    // Keep-alive: one connection (one proof) for both requests.
    expect(server.proofs).toEqual([null]);
  });

  it('carries a WebSocket (ws with the agent, no compression)', async () => {
    const server = await startPeerServer();
    const agent = makeAgent();
    const ws = new WebSocket(`wss://${TEST_HOST}:${String(server.port)}/remote/v1/ws`, {
      agent,
      ...REMOTE_WS_CLIENT_OPTIONS,
      headers: remoteVersionHeaders('1.2.3'),
    });
    const echo = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => {
        ws.send('hi');
      });
      ws.on('message', (data: Buffer) => {
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(echo).toBe('echo:hi');
    expect(ws.extensions).toBe('');
    ws.close();
  });

  it('a wrong server pin → refused in the handshake, 0 bytes of HTTP', async () => {
    const other = generateIdentity('identity');
    const server = await startPeerServer({ identity: other });
    const agent = makeAgent();
    const error = await refused(get(agent, server.port));
    expect(['tls', 'network']).toContain(error.reason);
    expect(server.requests).toEqual([]);
    expect(server.proofs).toEqual([]);
  });

  it('a wrong server proof → refused, 0 bytes of HTTP', async () => {
    const server = await startPeerServer({ serverProof: 'wrong' });
    const agent = makeAgent();
    expect((await refused(get(agent, server.port))).reason).toBe('proof_mismatch');
    expect(server.requests).toEqual([]);
  });

  it('a wrong client secret → the server refuses (proof mismatch), 0 requests', async () => {
    const server = await startPeerServer();
    const agent = makeAgent({ authKey: randomBytes(48) });
    expect((await refused(get(agent, server.port))).reason).toMatch(/^proof_/u);
    await expect.poll(() => server.proofs).toEqual(['mismatch']);
    expect(server.requests).toEqual([]);
  });

  it('refuses a certificate that does not match the pin at construction', () => {
    expect(() => makeAgent({ peerPin: generateIdentity('identity').pin })).toThrow(TypeError);
  });

  it('after destroy() it refuses new connections', async () => {
    const server = await startPeerServer();
    const agent = makeAgent();
    agent.destroy();
    expect(agent.isDestroyed).toBe(true);
    expect((await refused(get(agent, server.port))).reason).toBe('destroyed');
    expect(server.proofs).toEqual([]);
  });

  it('ignores TLS options of a single request (they live in the agent)', async () => {
    const server = await startPeerServer();
    const agent = makeAgent();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        // A request trying to switch verification off must not change anything.
        { host: TEST_HOST, port: server.port, path: '/x', agent, rejectUnauthorized: false, ca: [] },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    // And with a server of another key the same request is refused.
    const wrong = await startPeerServer({ identity: generateIdentity('identity') });
    const error = await refused(
      new Promise((resolve, reject) => {
        const req = request(
          { host: TEST_HOST, port: wrong.port, path: '/x', agent, rejectUnauthorized: false },
          resolve,
        );
        req.on('error', reject);
        req.end();
      }),
    );
    expect(['tls', 'network']).toContain(error.reason);
    expect(wrong.requests).toEqual([]);
  });
});
