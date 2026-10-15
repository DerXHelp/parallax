/**
 * R1-01 regression tests against a real server (port 0, raw sockets): the guard classifies by the
 * matched route, so percent-encoded, double-encoded, absolute-form, case-changed, trailing-slash
 * and dot-segment variants of the blob and WS routes never yield content (200) or an upgrade
 * (101) – without cookie, from a foreign origin, and even with a valid cookie unless canonical.
 * Every scenario runs without and with the static web UI (its `/*` route catches many variants).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { makeError } from '@shared/errors';
import { createServerInstance } from '../config';
import { createSyncHub } from '../sync/hub';
import { createMemorySessionSource } from '../sync/memorySource';
import { makeTempHome, rawRequest, rawUpgrade, startTestServer, type TestServer } from './testServer';

const SECRET = 'R1-01 blob secret 7f3a';
const EVIL: Record<string, string> = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
const NO_HEADERS: Record<string, string> = {};
const REJECTED = [400, 401, 403, 404];

let server: TestServer | null = null;
let bare: FastifyInstance | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  await bare?.close();
  bare = null;
});

async function start(withWeb: boolean): Promise<{ s: TestServer; blobId: string }> {
  let webRoot: string | undefined;
  if (withWeb) {
    webRoot = await makeTempHome('web-');
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>', 'utf8');
  }
  server = await startTestServer(webRoot === undefined ? {} : { webRoot });
  const ref = server.blobs.put(SECRET, 'text/plain');
  await server.blobs.flush();
  return { s: server, blobId: ref.blobId };
}

/** Every character percent-encoded (`abc` → `%61%62%63`). */
function encodeAll(text: string): string {
  return Array.from(
    { length: text.length },
    (_, i) => `%${text.charCodeAt(i).toString(16).padStart(2, '0')}`,
  ).join('');
}

function blobVariants(port: number, id: string): string[] {
  return [
    `/api/%62lob/${id}`,
    `/%61pi/blob/${id}`,
    `/%2561pi/blob/${id}`,
    `/api/blob/${encodeAll(id)}`,
    `/API/blob/${id}`,
    `/api/Blob/${id}`,
    `/api/blob/${id.toUpperCase()}`,
    `/api/blob/${id}/`,
    `//api/blob/${id}`,
    `/api/x/../blob/${id}`,
    `/api/./blob/${id}`,
    `/api/blob/${id};x`,
    `/api/blob/${id}%23`,
    `http://127.0.0.1:${String(port)}/api/blob/${id}`,
  ];
}

function wsVariants(port: number): string[] {
  return [
    '/%61pi/ws',
    '/api/%77s',
    '/api/%57S',
    '/%2561pi/ws',
    '/API/ws',
    '/api/WS',
    '/api/ws/',
    '//api/ws',
    '/api/x/../ws',
    '/api/./ws',
    '/api/ws;x',
    `http://127.0.0.1:${String(port)}/api/ws`,
    // upgrades on other routes are refused as well (no handshake-then-close on GET routes)
    '/api/health',
    '/api/auth/status',
    '/',
  ];
}

describe.each([
  ['without web UI', false],
  ['with web UI (static route /*)', true],
])('R1-01 guard %s', (_name, withWeb) => {
  it(
    'blob: no variant returns the content (no cookie, foreign origin, GET and HEAD)',
    { timeout: 30_000 },
    async () => {
      const { s, blobId } = await start(withWeb);
      for (const target of blobVariants(s.port, blobId)) {
        for (const method of ['GET', 'HEAD']) {
          for (const headers of [NO_HEADERS, EVIL]) {
            const res = await rawRequest(s.port, { method, path: target, headers });
            expect(
              REJECTED,
              `${method} ${target} ${JSON.stringify(headers)} → ${String(res.status)}`,
            ).toContain(res.status);
            expect(res.body, target).not.toContain(SECRET);
          }
        }
      }
    },
  );

  it(
    'blob: variants stay closed even with a valid cookie; only the canonical path serves',
    { timeout: 30_000 },
    async () => {
      const { s, blobId } = await start(withWeb);
      const cookie = await s.login();
      for (const target of blobVariants(s.port, blobId)) {
        const res = await rawRequest(s.port, { method: 'GET', path: target, headers: { cookie } });
        expect(REJECTED, `${target} → ${String(res.status)}`).toContain(res.status);
        expect(res.body, target).not.toContain(SECRET);
      }
      const canonical = `/api/blob/${blobId}`;
      expect((await rawRequest(s.port, { method: 'GET', path: canonical })).status).toBe(401);
      const ok = await rawRequest(s.port, { method: 'GET', path: canonical, headers: { cookie } });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe(SECRET);
    },
  );

  it('WS: no variant is upgraded (no cookie, foreign origin, cross-site)', { timeout: 30_000 }, async () => {
    const { s } = await start(withWeb);
    for (const target of wsVariants(s.port)) {
      for (const headers of [NO_HEADERS, EVIL, { origin: 'http://evil.example' }]) {
        const res = await rawUpgrade(s.port, target, headers);
        expect(REJECTED, `${target} ${JSON.stringify(headers)} → ${String(res.status)}`).toContain(
          res.status,
        );
      }
    }
    // HEAD on the WS route is never upgraded either.
    expect((await rawUpgrade(s.port, '/api/ws', EVIL, { method: 'HEAD' })).status).not.toBe(101);
  });

  it(
    'WS: variants are refused even with a valid cookie and the own origin',
    { timeout: 30_000 },
    async () => {
      const { s } = await start(withWeb);
      const cookie = await s.login();
      for (const target of wsVariants(s.port)) {
        const res = await rawUpgrade(s.port, target, { cookie, origin: s.origin });
        expect(REJECTED, `${target} → ${String(res.status)}`).toContain(res.status);
      }
    },
  );

  it(
    'WS (V1-01): the canonical upgrade works like a browser sends it – Origin + cookie, no Sec-Fetch-Site',
    { timeout: 30_000 },
    async () => {
      const { s } = await start(withWeb);
      const cookie = await s.login();
      expect((await rawUpgrade(s.port, '/api/ws', { cookie, origin: s.origin })).status).toBe(101);
      expect(
        (await rawUpgrade(s.port, '/api/ws', { cookie, origin: s.origin, 'sec-fetch-site': 'same-origin' }))
          .status,
      ).toBe(101);
      const crossSite = await rawUpgrade(s.port, '/api/ws', {
        cookie,
        origin: s.origin,
        'sec-fetch-site': 'cross-site',
      });
      expect(crossSite.status).toBe(403);
      expect(crossSite.text).toContain('"reason":"sec-fetch-site"');
      const noCookie = await rawUpgrade(s.port, '/api/ws', { origin: s.origin });
      expect(noCookie.status).toBe(401);
      const noOrigin = await rawUpgrade(s.port, '/api/ws', { cookie });
      expect(noOrigin.status).toBe(403);
    },
  );
});

describe('WS route second line (hub.attach authorizeUpgrade)', () => {
  async function bareApp(authorize: () => ReturnType<typeof makeError> | null): Promise<number> {
    // No app guard at all: only the hub's own route checks protect the upgrade.
    const app = fastify();
    await app.register(fastifyWebsocket);
    const hub = createSyncHub({
      source: createMemorySessionSource(),
      instance: createServerInstance({ serverVersion: '0.0.0-test' }),
      timing: { heartbeatMs: 0 },
    });
    hub.attach(app, { authorizeUpgrade: authorize });
    await app.listen({ host: '127.0.0.1', port: 0 });
    bare = app;
    const address = app.server.address();
    if (address === null || typeof address !== 'object') throw new Error('not listening');
    return address.port;
  }

  it('answers the authorizer error over HTTP in preValidation (never 101)', async () => {
    const port = await bareApp(() => makeError('AUTH_REQUIRED'));
    const res = await rawUpgrade(port, '/api/ws');
    expect(res.status).toBe(401);
    expect(res.text).toContain('"code":"AUTH_REQUIRED"');
  });

  it('upgrades when the authorizer allows it', async () => {
    const port = await bareApp(() => null);
    expect((await rawUpgrade(port, '/api/ws')).status).toBe(101);
  });

  it('terminates a socket that reaches the WS handler unauthorized, before any hello', async () => {
    let calls = 0;
    // preValidation passes, the check inside the WS handler fails (simulated bypassed hook).
    const port = await bareApp(() => (++calls === 1 ? null : makeError('AUTH_REQUIRED')));
    const messages: string[] = [];
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
      socket.on('message', (data: Buffer) => messages.push(data.toString('utf8')));
      socket.on('close', (closeCode) => {
        resolve(closeCode);
      });
      socket.on('error', () => undefined);
    });
    expect(code).toBe(1006);
    expect(messages).toEqual([]);
    expect(calls).toBe(2);
  });
});
