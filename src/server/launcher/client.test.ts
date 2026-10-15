import { createServer, type Server } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authCodeSchema } from '@shared/http';
import { sampleHealthResponse, sampleToken, sampleUuid } from '@shared/samples';
import { makeTempHome, startTestServer, type TestServer } from '../http/testServer';
import {
  checkHealth,
  findRunningServer,
  requestLauncherCode,
  type HealthCheck,
  type HttpJson,
  type HttpJsonRequest,
} from './client';
import { serverLockPath, writeServerLock } from './lockFile';

// Real processes, git and a real server: generous limits, the machine may be busy (parallel checks).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return address.port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return portOf(server);
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A port nothing listens on: bind, remember, close. */
async function deadPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

describe('launcher client against the real server (WP-10 routes and guard)', () => {
  let server: TestServer;
  let foreign: Server;
  let foreignPort: number;

  beforeAll(async () => {
    server = await startTestServer();
    foreign = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not parallax</html>');
    });
    foreignPort = await listen(foreign);
  });

  afterAll(async () => {
    await server.close();
    await close(foreign);
    await rm(server.home, { recursive: true, force: true });
  });

  it('health: ok with the instance UUID', async () => {
    const check = await checkHealth(server.port);
    expect(check).toMatchObject({
      kind: 'ok',
      health: { product: 'parallax', serverInstanceId: server.instance.serverInstanceId },
    });
  });

  it('health: down when nothing listens, foreign for other programs', async () => {
    expect(await checkHealth(await deadPort())).toEqual({ kind: 'down', reason: 'ECONNREFUSED' });
    expect(await checkHealth(foreignPort)).toEqual({ kind: 'foreign', status: 200 });
  });

  it('launcher code: accepted without Origin (Bearer token), single use code', async () => {
    const result = await requestLauncherCode(server.port, server.auth.launcherToken);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(authCodeSchema.safeParse(result.response.code).success).toBe(true);
    expect(result.response.serverInstanceId).toBe(server.instance.serverInstanceId);
    expect(server.auth.exchangeCode(result.response.code)).toBe(true);
  });

  it('launcher code: a wrong token is token_invalid, a dead port failed', async () => {
    expect(await requestLauncherCode(server.port, sampleToken(9))).toEqual({ kind: 'token_invalid' });
    expect(await requestLauncherCode(await deadPort(), sampleToken(9))).toEqual({
      kind: 'failed',
      reason: 'ECONNREFUSED',
    });
  });

  it('single instance: running only when the lock matches the answering instance', async () => {
    const home = await makeTempHome('wp21-client-');
    try {
      expect(await findRunningServer({ home })).toEqual({ kind: 'none', reason: 'no_lock', staleLock: null });

      await writeFile(serverLockPath(home), '{"schemaVersion":1');
      expect(await findRunningServer({ home })).toEqual({
        kind: 'none',
        reason: 'invalid_lock',
        staleLock: null,
      });

      const lock = await writeServerLock({
        home,
        port: server.port,
        instance: server.instance,
        launcherToken: server.auth.launcherToken,
      });
      const running = await findRunningServer({ home });
      expect(running).toMatchObject({ kind: 'running', lock: lock.lock });

      // Same port, other instance (server restarted from another home / lock of an older run).
      await writeServerLock({
        home,
        port: server.port,
        instance: { ...server.instance, serverInstanceId: sampleUuid(77) },
        launcherToken: sampleToken(3),
      });
      expect(await findRunningServer({ home })).toMatchObject({ kind: 'none', reason: 'other_instance' });

      // Crashed server: nothing answers on the lock's port.
      const port = await deadPort();
      await writeServerLock({ home, port, instance: server.instance, launcherToken: sampleToken(3) });
      expect(await findRunningServer({ home })).toMatchObject({
        kind: 'none',
        reason: 'unreachable',
        staleLock: { port },
      });

      await writeServerLock({
        home,
        port: foreignPort,
        instance: server.instance,
        launcherToken: sampleToken(3),
      });
      expect(await findRunningServer({ home })).toMatchObject({ kind: 'none', reason: 'foreign' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('launcher client parsing (fake transport)', () => {
  const answer =
    (status: number, body: unknown): HttpJson =>
    () =>
      Promise.resolve({ status, body });

  it('rejects a health body that does not match the contract', async () => {
    const check = await checkHealth(1, {
      http: answer(200, { ...sampleHealthResponse(), product: 'other' }),
    });
    expect(check).toEqual({ kind: 'foreign', status: 200 });
  });

  it('maps a timeout to down', async () => {
    const http: HttpJson = () => Promise.reject(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }));
    expect(await checkHealth(1, { http })).toEqual({ kind: 'down', reason: 'ETIMEDOUT' });
  });

  it('sends the bearer token with an empty JSON body and no Origin', async () => {
    const seen: HttpJsonRequest[] = [];
    const http: HttpJson = (request) => {
      seen.push(request);
      return Promise.resolve({ status: 500, body: null });
    };
    expect(await requestLauncherCode(1, sampleToken(4), { http })).toEqual({
      kind: 'failed',
      reason: 'HTTP 500',
    });
    expect(seen).toEqual([
      expect.objectContaining({
        port: 1,
        method: 'POST',
        path: '/api/launcher/code',
        body: '{}',
        headers: { authorization: `Bearer ${sampleToken(4)}`, 'content-type': 'application/json' },
      }),
    ]);
  });

  it('times out a server that never answers (real transport)', async () => {
    const silent = createServer(() => undefined);
    const port = await listen(silent);
    try {
      const check: HealthCheck = await checkHealth(port, { timeoutMs: 100 });
      expect(check).toEqual({ kind: 'down', reason: 'ETIMEDOUT' });
    } finally {
      await close(silent);
    }
  });
});
