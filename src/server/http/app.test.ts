import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BLOB_CSP, authCookieName, healthResponseSchema, pageCsp } from '@shared/http';
import { createServerInstance } from '../config';
import { createBlobStore, type FileBlobStore } from '../store/blobs';
import { createSyncHub } from '../sync/hub';
import { createMemorySessionSource } from '../sync/memorySource';
import { createApp, safeMediaType } from './app';
import { createAuthService, type AuthService } from './auth';
import { makeTempHome, rawRequest, startTestServer, type TestServer } from './testServer';

const PORT = 4711;
const HOST = '127.0.0.1:4711';
const ORIGIN = 'http://127.0.0.1:4711';

interface Fixture {
  app: FastifyInstance;
  auth: AuthService;
  blobs: FileBlobStore;
  cookie: string;
  instanceId: string;
}

let fixture: Fixture | null = null;
let server: TestServer | null = null;

// The first server of a worker pays a one-time warm-up (~2 s idle, >10 s under parallel load,
// docs/wp/FLAKES.md). It is paid here with a generous hook limit, so no single test carries it.
beforeAll(async () => {
  const warm = await startTestServer();
  await rawRequest(warm.port, { method: 'GET', path: '/api/health' });
  await warm.close();
}, 60_000);

afterEach(async () => {
  await fixture?.app.close();
  fixture = null;
  await server?.close();
  server = null;
});

async function setup(
  options: { webRoot?: string; dev?: boolean; backend?: 'sdk' | 'fake' } = {},
): Promise<Fixture> {
  const home = await makeTempHome('app-');
  const instance = createServerInstance({ serverVersion: '1.2.3' });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const hub = createSyncHub({ source: createMemorySessionSource(), instance, timing: { heartbeatMs: 0 } });
  const app = await createApp({
    config: {
      port: PORT,
      dev: options.dev ?? false,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
    },
    instance,
    auth,
    blobs,
    hub,
    webRoot: options.webRoot ?? null,
  });
  fixture = {
    app,
    auth,
    blobs,
    cookie: `${authCookieName(PORT)}=${auth.createCookieValue()}`,
    instanceId: instance.serverInstanceId,
  };
  return fixture;
}

describe('createApp', () => {
  it('answers /api/health without auth and without secrets', async () => {
    const { app, instanceId } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json())).toEqual({
      ok: true,
      product: 'parallax',
      serverInstanceId: instanceId,
      serverVersion: '1.2.3',
      buildId: 'dev',
      startedAt: expect.any(String) as string,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports the backend kind in /api/health (R3-02)', async () => {
    const { app } = await setup({ backend: 'fake' });
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(healthResponseSchema.parse(res.json()).backend).toBe('fake');
  });

  it('sets security headers and never CORS headers', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe(pageCsp(PORT));
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth',
      headers: { host: HOST, origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(403);
    expect(Object.keys(preflight.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });

  it('page CSP follows C.10', () => {
    const csp = pageCsp(4711);
    for (const part of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws://127.0.0.1:4711",
    ]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });

  it('serves blobs with nosniff, sandbox CSP and CORP, only with the cookie', async () => {
    const { app, blobs, cookie } = await setup();
    const ref = blobs.put('<svg onload="alert(1)"/>', 'image/svg+xml', 'x.svg');
    await blobs.flush();
    const url = `/api/blob/${ref.blobId}`;
    expect((await app.inject({ method: 'GET', url, headers: { host: HOST } })).json()).toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const res = await app.inject({ method: 'GET', url, headers: { host: HOST, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<svg onload="alert(1)"/>');
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(BLOB_CSP);
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');

    const missing = await app.inject({
      method: 'GET',
      url: `/api/blob/${'0'.repeat(64)}`,
      headers: { host: HOST, cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'BLOB_NOT_FOUND', params: {} });
    // Not a canonical API path (percent-encoding, dots): rejected before the route runs (R1-01).
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/blob/..%2F..%2Fsecret',
      headers: { host: HOST, cookie },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'request_target' } });
    const head = await app.inject({ method: 'HEAD', url, headers: { host: HOST } });
    expect(head.statusCode).toBe(401);
  });

  it('falls back to application/octet-stream for odd media types', () => {
    expect(safeMediaType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(safeMediaType('text/html\r\nx-injected: 1')).toBe('application/octet-stream');
    expect(safeMediaType('nonsense')).toBe('application/octet-stream');
  });

  it('answers errors with an ErrorPayload and the catalog status', async () => {
    const { app, cookie } = await setup();
    const mutation = { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie };
    const unknown = await app.inject({ method: 'GET', url: '/api/nope', headers: { host: HOST } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: 'ROUTE_NOT_FOUND', params: { path: '/api/nope' } });
    expect(unknown.headers['cache-control']).toBe('no-store');

    const badJson = await app.inject({
      method: 'POST',
      url: '/api/auth',
      headers: { ...mutation, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/auth',
      headers: { ...mutation, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'x'.repeat(100 * 1024) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const noUpgrade = await app.inject({ method: 'GET', url: '/api/ws', headers: mutation });
    expect(noUpgrade.statusCode).toBe(400);
    expect(noUpgrade.json()).toMatchObject({
      code: 'INVALID_MESSAGE',
      params: { reason: 'upgrade_required' },
    });

    const badCode = await app.inject({
      method: 'POST',
      url: '/api/auth',
      headers: { ...mutation, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 42 }),
    });
    expect(badCode.statusCode).toBe(401);
    expect(badCode.json()).toEqual({ code: 'AUTH_CODE_INVALID', params: {} });
  });

  it('serves the built web UI with the page CSP', async () => {
    const webRoot = await makeTempHome('web-');
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log(1)', 'utf8');
    const { app } = await setup({ webRoot });
    const index = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>x</title>');
    expect(index.headers['content-security-policy']).toBe(pageCsp(PORT));
    expect(index.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: { host: HOST } });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).not.toBe('no-store');
    // V1-06: a missing static file is a 404 (not 501).
    const favicon = await app.inject({ method: 'GET', url: '/favicon.ico', headers: { host: HOST } });
    expect(favicon.statusCode).toBe(404);
    expect(favicon.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    expect(
      (await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode,
    ).toBe(403);
  });

  it('issues one dev login code on listen in dev mode', async () => {
    const { app, auth } = await setup({ dev: true });
    let issued = 0;
    const original = auth.issueAuthCode.bind(auth);
    auth.issueAuthCode = (ttl) => {
      issued += 1;
      return original(ttl);
    };
    await app.listen({ host: '127.0.0.1', port: 0 });
    expect(issued).toBe(1);
  });
});

describe('rejected WebSocket upgrades', () => {
  it('get an HTTP error answer and the server closes the socket', async () => {
    server = await startTestServer();
    const { port } = server;
    const result = await new Promise<{ head: string; closed: boolean }>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'GET /api/ws HTTP/1.1',
            `Host: 127.0.0.1:${String(port)}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Origin: http://evil.example',
            'Sec-Fetch-Site: cross-site',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let head = '';
      socket.on('data', (chunk: Buffer) => {
        head += chunk.toString('utf8');
      });
      socket.on('close', () => {
        resolve({ head, closed: true });
      });
      socket.on('error', reject);
      // Deadline only for a server that never closes (fails below); 3 s were tight under load.
      setTimeout(() => {
        resolve({ head, closed: false });
      }, 15_000).unref();
    });
    expect(result.head).toMatch(/^HTTP\/1\.1 403/);
    expect(result.head).toContain('"code":"ORIGIN_REJECTED"');
    expect(result.closed).toBe(true);
  });
});
