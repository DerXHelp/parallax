import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { takeAuthCodeFromHash } from '@shared/http';
import { makeTempHome } from '../http/testServer';
import { isProcessAlive, killProcessTree } from '../lib/process';
import { checkHealth } from './client';
import { LauncherError, createNodeLauncherDeps, runLauncher, type LauncherDeps } from './launcher';
import { readServerLock } from './lockFile';
import { serverOutLogPath } from './serverProcess';

/**
 * End to end with real processes: the launcher spawns a FAKE server script (temp folder) instead
 * of dist/server.js – detached, hidden, stdout into server.out.log – and talks to it over HTTP.
 * The fake speaks the launcher-relevant contract: lock file after listen, GET /api/health,
 * POST /api/launcher/code (Bearer token, no Origin). Edge is replaced by a recorder.
 * PARALLAX_HOME is a temp folder, the port 0.
 */
const FAKE_SERVER = `
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

// Like writeServerLock (R2-01): the launcher reads the old lock file in a loop while this server
// replaces it – on Windows that rename fails with EPERM/EBUSY/EACCES as long as a reader has the
// file open. Retry with backoff (synchronously, before "listening" is reported), up to ~10 s.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function replaceFile(tmp, file) {
  const deadline = Date.now() + 10_000;
  for (let delay = 10; ; delay = Math.min(delay * 2, 400)) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || Date.now() > deadline) throw error;
      pause(delay);
    }
  }
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
const mode = process.env.FAKE_SERVER_MODE ?? 'ok';
setTimeout(() => process.exit(0), 60_000).unref(); // safety net: never outlive the test run
if (mode === 'exit3') {
  process.stderr.write('sessions.json was written by a newer Parallax (schemaVersion 9) - update Parallax.\\n');
  process.exit(3);
}
const instanceId = randomUUID();
const token = randomBytes(32).toString('base64url');
const startedAt = new Date().toISOString();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, { ok: true, product: 'parallax', serverInstanceId: instanceId, serverVersion: '0.0.0-fake', buildId: 'fake', startedAt });
  }
  if (req.method === 'POST' && req.url === '/api/launcher/code') {
    if (req.headers.origin !== undefined || req.headers.authorization !== 'Bearer ' + token) {
      return json(res, 401, { code: 'LAUNCHER_TOKEN_INVALID', params: {} });
    }
    req.resume();
    return req.on('end', () => json(res, 200, {
      code: randomBytes(32).toString('base64url'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverInstanceId: instanceId,
    }));
  }
  json(res, 404, { code: 'ROUTE_NOT_FOUND', params: {} });
});
server.on('error', (error) => { process.stderr.write(String(error.code) + '\\n'); process.exit(error.code === 'EADDRINUSE' ? 4 : 1); });
// A real server needs a moment (stores, recovery) before it listens and writes its lock file.
const startDelay = Number(process.env.FAKE_SERVER_DELAY_MS ?? '0');
setTimeout(() => server.listen(Number(args.port), '127.0.0.1', () => {
  const port = server.address().port;
  const lock = { schemaVersion: 1, pid: process.pid, port, serverInstanceId: instanceId, launcherToken: token, startedAt, buildId: 'fake' };
  const file = path.join(args.home, 'server.lock.json');
  writeFileSync(file + '.tmp', JSON.stringify(lock));
  replaceFile(file + '.tmp', file);
  process.stdout.write('fake server listening on ' + port + '\\n');
}), startDelay);
`;

// Real processes, git and a real server: generous limits, the machine may be busy (parallel checks).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let scriptDir: string;
let fakeServer: string;
const homes: string[] = [];
const pids = new Set<number>();

beforeAll(async () => {
  scriptDir = await makeTempHome('wp21-fake-');
  fakeServer = path.join(scriptDir, 'fake-server.mjs');
  await writeFile(fakeServer, FAKE_SERVER);
});

afterEach(async () => {
  for (const pid of pids) {
    if (isProcessAlive(pid)) await killProcessTree(pid);
  }
  pids.clear();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 5 });
});

afterAll(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

interface Harness {
  home: string;
  deps: LauncherDeps;
  out: string[];
  windows: string[];
}

async function harness(mode = 'ok', options: { home?: string; delayMs?: number } = {}): Promise<Harness> {
  const home =
    options.home ?? (await mkdtemp(path.join(process.env.PARALLAX_HOME ?? scriptDir, 'wp21-home-')));
  if (options.home === undefined) homes.push(home);
  const out: string[] = [];
  const windows: string[] = [];
  const deps = createNodeLauncherDeps({
    repoRoot: process.cwd(),
    home,
    serverScript: fakeServer,
    env: { ...process.env, FAKE_SERVER_MODE: mode, FAKE_SERVER_DELAY_MS: String(options.delayMs ?? 0) },
    out: (line) => out.push(line),
  });
  deps.locateEdge = () => Promise.resolve('C:\\Edge\\msedge.exe');
  deps.openEdge = (_edge, args) => {
    const app = args.find((arg) => arg.startsWith('--app='));
    windows.push(app?.slice('--app='.length) ?? '');
    return Promise.resolve({ pid: null });
  };
  return { home, deps, out, windows };
}

const run = (h: Harness, port = 0) =>
  runLauncher(
    {
      home: h.home,
      port,
      serverArgs: [`--home=${h.home}`, `--port=${String(port)}`],
      build: false,
      printUrl: false,
      readyTimeoutMs: 60_000,
    },
    h.deps,
  );

describe('launcher with a fake server process', () => {
  it('fresh start → second start opens only a window → stale lock after a crash → new server', async () => {
    const h = await harness();

    const first = await run(h);
    pids.add(first.pid);
    expect(first.mode).toBe('started');
    expect(isProcessAlive(first.pid)).toBe(true);
    const lock = await readServerLock(h.home);
    expect(lock).toMatchObject({ kind: 'ok', lock: { pid: first.pid, port: first.port } });
    expect(await checkHealth(first.port)).toMatchObject({ kind: 'ok' });
    expect(h.windows).toHaveLength(1);
    const firstCode = takeAuthCodeFromHash(new URL(h.windows[0] ?? '').hash).code;
    expect(firstCode).not.toBeNull();
    expect(h.windows[0]).toContain(`http://127.0.0.1:${String(first.port)}/#code=`);
    expect(await readFile(serverOutLogPath(h.home), 'utf8')).toContain(
      `fake server listening on ${String(first.port)}`,
    );

    // Second start: same server, only a new window with a new code.
    const second = await run(h);
    expect(second).toMatchObject({ mode: 'existing', pid: first.pid, port: first.port });
    expect(h.windows).toHaveLength(2);
    expect(takeAuthCodeFromHash(new URL(h.windows[1] ?? '').hash).code).not.toBe(firstCode);

    // Crash: the lock file stays, but nothing answers → a new server is started.
    await killProcessTree(first.pid);
    expect(await readServerLock(h.home)).toMatchObject({ kind: 'ok', lock: { pid: first.pid } });
    const third = await run(h);
    pids.add(third.pid);
    expect(third.mode).toBe('started');
    expect(third.pid).not.toBe(first.pid);
    expect(h.out.join('\n')).toContain('stale lock file');
    expect(await readServerLock(h.home)).toMatchObject({ kind: 'ok', lock: { pid: third.pid } });
  }, 180_000);

  it('double click: two launchers at once start ONE server and open two windows of it (R3-04)', async () => {
    const first = await harness('ok', { delayMs: 1_500 });
    const second = await harness('ok', { home: first.home, delayMs: 1_500 });
    const [a, b] = await Promise.all([run(first), run(second)]);
    pids.add(a.pid);
    pids.add(b.pid);
    expect([a.mode, b.mode].sort()).toEqual(['existing', 'started']);
    expect(a.pid).toBe(b.pid);
    expect(a.port).toBe(b.port);
    expect([...first.windows, ...second.windows]).toHaveLength(2);
    expect([...first.out, ...second.out].join('\n')).toContain('by another launcher - waiting for it');
    // Exactly one server process was started (one "listening" line in its output log).
    const log = await readFile(serverOutLogPath(first.home), 'utf8');
    expect(log.match(/fake server listening/g)).toHaveLength(1);
  }, 120_000);

  it('exit code 3 of the server → "update Parallax" with the server output', async () => {
    const h = await harness('exit3');
    const error = await run(h).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LauncherError);
    if (!(error instanceof LauncherError)) return;
    expect(error.reason).toBe('store_too_new');
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('Server output: sessions.json was written by a newer Parallax');
  }, 90_000);

  it('a busy port is reported before anything is started', async () => {
    const h = await harness();
    // Another program on the port (drops every connection, so the health ping fails fast).
    const blocker: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    try {
      if (address === null || typeof address === 'string') throw new Error('not listening');
      const error = await run(h, address.port).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LauncherError);
      expect(error instanceof LauncherError ? error.reason : null).toBe('port_in_use');
      expect(await readServerLock(h.home)).toEqual({ kind: 'missing' });
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  }, 90_000);
});
