/**
 * `startServer()` in-process (FakeBackend speed 0, temp PARALLAX_HOME, port 0, no signal handlers,
 * `exit` recorded): lock file, static UI, shutdown hook, single instance (5), newer store (3),
 * port in use (4) with a complete cleanup. The process view (tsx, real exit codes, WS flow) is in
 * `main.integration.test.ts`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleId } from '@shared/samples';
import { loadConfig } from '../config';
import { makeTempHome, rawRequest } from '../http/testServer';
import { checkHealth } from '../launcher/client';
import { SERVER_EXIT_CODES } from '../launcher/exitCodes';
import { readServerLock } from '../launcher/lockFile';
import type { CommandContext } from '../sync/ports';
import { StartupError, startServer, type RunningServer } from './compose';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempHome(): Promise<string> {
  const home = await makeTempHome('wp20a-compose-');
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return home;
}

interface Started {
  server: RunningServer;
  exits: number[];
}

async function start(
  home: string,
  options: { port?: number; webRoot?: string | null } = {},
): Promise<Started> {
  const exits: number[] = [];
  const config = loadConfig({
    argv: ['--backend=fake', `--port=${String(options.port ?? 0)}`, `--home=${home}`],
    env: {},
  });
  const server = await startServer({
    config,
    webRoot: options.webRoot ?? null,
    signals: null,
    fakeSpeed: 0,
    exit: (code) => exits.push(code),
  });
  cleanups.push(() => server.shutdown.stop('command'));
  return { server, exits };
}

async function startError(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof StartupError)) throw new Error(`expected a StartupError, got ${String(error)}`);
  return error;
}

describe('startServer (composition)', () => {
  it('listens, writes the lock file with the actual port, serves dist/web and shuts down in order', async () => {
    const home = await tempHome();
    const webRoot = path.join(home, 'web');
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Parallax</title>');
    const { server, exits } = await start(home, { webRoot });

    expect(server.port).toBeGreaterThan(0);
    const lock = await readServerLock(home);
    expect(lock).toEqual({ kind: 'ok', lock: server.lock.lock });
    expect(server.lock.lock).toMatchObject({
      port: server.port,
      pid: process.pid,
      serverInstanceId: server.instance.serverInstanceId,
      launcherToken: server.auth.launcherToken,
    });
    expect(await checkHealth(server.port)).toMatchObject({
      kind: 'ok',
      health: { serverInstanceId: server.instance.serverInstanceId },
    });
    const page = await rawRequest(server.port, {
      method: 'GET',
      path: '/',
      headers: { host: `127.0.0.1:${String(server.port)}` },
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Parallax</title>');
    expect(server.manager.hostState()).toMatchObject({ backend: 'fake', dev: false, setupRequired: false });

    await server.shutdown.stop('command');
    expect(exits).toEqual([SERVER_EXIT_CODES.ok]);
    expect(server.app.server.listening).toBe(false);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
    // Commands after the shutdown are refused by the engine.
    await expect(server.manager.handleCommand({ name: 'server.shutdown' }, ctx())).rejects.toMatchObject({
      error: { code: 'SERVER_SHUTTING_DOWN' },
    });
  });

  it('refuses a second server on the same PARALLAX_HOME (exit code 5)', async () => {
    const home = await tempHome();
    const first = await start(home);
    const error = await startError(start(home));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.alreadyRunning);
    expect(error.message).toContain(`port ${String(first.server.port)}`);
    // The first server is untouched.
    expect(await readServerLock(home)).toMatchObject({ kind: 'ok', lock: { port: first.server.port } });
  });

  it('aborts with exit code 3 on a store of a newer Parallax and leaves the file unchanged', async () => {
    const home = await tempHome();
    const file = path.join(home, 'processes.json');
    const content = `${JSON.stringify({ schemaVersion: 7, records: [] })}\n`;
    await writeFile(file, content);
    const error = await startError(start(home));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.storeVersionTooNew);
    expect(error.message).toContain('processes.json was written by a newer Parallax');
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('port in use → exit code 4, everything closed again (a new start on the same home works)', async () => {
    const home = await tempHome();
    const blocker: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    );
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('blocker not listening');

    const error = await startError(start(home, { port: address.port }));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.portInUse);
    expect(error.message).toContain('EADDRINUSE');
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });

    const again = await start(home);
    expect(await checkHealth(again.server.port)).toMatchObject({ kind: 'ok' });
  });
});

function ctx(): CommandContext {
  return { clientId: sampleId('cl', 1), cmdId: '00000000-0000-4000-8000-000000000001' };
}
