import { get as httpGet } from 'node:http';
import { PassThrough } from 'node:stream';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { makeError } from '@shared/errors';
import { WS_CLOSE } from '@shared/protocol';
import type { RemoteHost } from '@shared/model';
import { SAMPLE_IDS, sampleRemoteHost } from '@shared/samples';
import type { HostForwarder, UpstreamRequest, UpstreamResponse } from '../hosts/ports';
import { registerHostRoutes, type ForwardLimits } from './hostRoutes';
import type { BridgeLimits } from './hostSocket';

const BLOB = 'a'.repeat(64);
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface Fake {
  app: FastifyInstance;
  host: RemoteHost;
  requests: UpstreamRequest[];
}

/** The routes on a bare Fastify with a fake forwarder (the app's guards are tested elsewhere). */
async function routes(
  answer: (request: UpstreamRequest) => Promise<UpstreamResponse>,
  options: {
    host?: Partial<RemoteHost>;
    forward?: Partial<ForwardLimits>;
    bridge?: Partial<BridgeLimits>;
    connectWindow?: HostForwarder['connectWindow'];
  } = {},
): Promise<Fake> {
  const host = sampleRemoteHost({ status: 'connected', ...options.host });
  const requests: UpstreamRequest[] = [];
  const forwarder: HostForwarder = {
    connectWindow: options.connectWindow ?? (() => Promise.reject(new Error('no windows here'))),
    request: (_hostId, request) => {
      requests.push(request);
      return answer(request);
    },
    closeWindows: () => undefined,
  };
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyWebsocket);
  await registerHostRoutes(app, {
    hosts: { list: () => [host], forwarder },
    authorizeUpgrade: () => null,
    forward: options.forward ?? {},
    bridge: options.bridge ?? {},
  });
  await app.ready();
  return { app, host, requests };
}

/** Never answers – rejects only when the request is aborted. */
function hang(request: UpstreamRequest): Promise<UpstreamResponse> {
  return new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
}

describe('forwarder routes: limits against a slow or hostile computer (WP-82 review)', () => {
  it('no headers within the deadline → HOST_UNREACHABLE timeout, the upstream request is aborted', async () => {
    const fake = await routes(hang, { forward: { headersMs: 100 } });
    const response = await fake.app.inject({
      method: 'GET',
      url: `/api/hosts/${fake.host.hostId}/blob/${BLOB}`,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'timeout' } });
    expect(fake.requests[0]?.signal?.aborted).toBe(true);
  });

  it('a computer the watcher reports unreachable is refused at once', async () => {
    const lastError = makeError('HOST_UNREACHABLE', { reason: 'refused' });
    const fake = await routes(hang, { host: { status: 'unreachable', lastError } });
    const response = await fake.app.inject({
      method: 'GET',
      url: `/api/hosts/${fake.host.hostId}/blob/${BLOB}`,
    });
    expect(response.json()).toEqual(lastError);
    expect(fake.requests).toHaveLength(0);
  });

  it('at most perHost open requests; the next one is refused as busy', async () => {
    const fake = await routes(hang, { forward: { perHost: 1, headersMs: 2_000 } });
    const first = fake.app.inject({ method: 'GET', url: `/api/hosts/${fake.host.hostId}/blob/${BLOB}` });
    await expect.poll(() => fake.requests.length).toBe(1);
    const second = await fake.app.inject({
      method: 'GET',
      url: `/api/hosts/${fake.host.hostId}/blob/${BLOB}`,
    });
    expect(second.json()).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'busy' } });
    expect((await first).statusCode).toBe(502);
  });

  it('a body that trickles below the minimum rate is cut', async () => {
    const body = new PassThrough();
    const fake = await routes(
      () => Promise.resolve({ status: 200, headers: { 'content-type': 'text/plain' }, body }),
      { forward: { windowMs: 100, minBytesPerWindow: 1024 } },
    );
    body.write('x'.repeat(10));
    await fake.app.listen({ host: '127.0.0.1', port: 0 });
    const address = fake.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const path = `/api/hosts/${fake.host.hostId}/file?entryId=${SAMPLE_IDS.entry}&path=${encodeURIComponent('C:\\p\\a.txt')}`;
    const started = Date.now();
    // The 200 head went out; the transfer breaks off early instead of waiting for the rest.
    const outcome = await new Promise<{ status: number; complete: boolean }>((resolve, reject) => {
      const req = httpGet({ host: '127.0.0.1', port: address.port, path }, (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, complete: res.complete });
        });
        res.on('error', () => {
          resolve({ status: res.statusCode ?? 0, complete: false });
        });
        res.on('close', () => {
          resolve({ status: res.statusCode ?? 0, complete: res.complete });
        });
      });
      req.on('error', reject);
    });
    expect(outcome).toEqual({ status: 200, complete: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(body.destroyed).toBe(true);
  });

  it('a forwarded window whose other computer stays silent ends with HOST_UNREACHABLE', async () => {
    // The "other computer": accepts the WebSocket and never sends anything (no message, no ping).
    const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => silent.once('listening', resolve));
    const upstreamPort = (silent.address() as { port: number }).port;
    const fake = await routes(() => Promise.reject(new Error('no http')), {
      bridge: { upstreamIdleMs: 200 },
      connectWindow: () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${String(upstreamPort)}`);
          ws.once('open', () => {
            resolve(ws);
          });
          ws.once('error', reject);
        }),
    });
    try {
      await fake.app.listen({ host: '127.0.0.1', port: 0 });
      const address = fake.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const browser = new WebSocket(
        `ws://127.0.0.1:${String(address.port)}/api/hosts/${fake.host.hostId}/ws`,
      );
      const code = await new Promise<number>((resolve) => {
        browser.once('close', resolve);
      });
      expect(code).toBe(WS_CLOSE.HOST_UNREACHABLE);
    } finally {
      for (const client of silent.clients) client.terminate();
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
    }
  });
});
