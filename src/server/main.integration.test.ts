/**
 * WP-20a: the real server entry (`src/server/main.ts`, run by tsx like `pnpm dev:server`) as a child
 * process with `--backend=fake`, a temp PARALLAX_HOME and port 0. Everything goes over the wire like
 * the launcher and the browser do it: lock file → health → one-time code over the launcher endpoint
 * (Bearer token) → device cookie → WS hello → session with a permission → answer → idle →
 * `server.shutdown` → the process ends, the lock file is gone, no child process is left.
 * Plus the start aborts with exit code 3 (store of a newer Parallax) and 4 (port in use).
 */
import type { ChildProcess } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryIdSchema } from '@shared/common';
import { authCookieName, serverOrigin, type ServerLockFile } from '@shared/http';
import type { Decision } from '@shared/model';
import { PROTOCOL_VERSION, type ServerMessage } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import {
  connectWs,
  cookieFromSetCookie,
  makeTempHome,
  rawRequest,
  type TestWsClient,
} from './http/testServer';
import { checkHealth, requestLauncherCode } from './launcher/client';
import { SERVER_EXIT_CODES } from './launcher/exitCodes';
import { readServerLock } from './launcher/lockFile';
import { childProcesses, isProcessAlive, killProcessTree, spawnHidden } from './lib/process';

// Real processes (tsx compiles the whole server on start): generous bounds for parallel load.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_TSCONFIG = path.join(repoRoot, 'src', 'server', 'tsconfig.json');
const SERVER_MAIN = path.join(repoRoot, 'src', 'server', 'main.ts');
const READY_TIMEOUT_MS = 90_000;

interface ServerProcess {
  child: ChildProcess;
  /** Combined stdout + stderr so far. */
  output(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

const running = new Set<ChildProcess>();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Processes first (a failed test may leave the server running and holding files in its home).
  for (const child of running) {
    if (child.pid !== undefined && isProcessAlive(child.pid)) await killProcessTree(child.pid);
  }
  running.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempHome(prefix);
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function spawnServer(args: readonly string[]): ServerProcess {
  let out = '';
  let err = '';
  const child = spawnHidden(
    process.execPath,
    [TSX_CLI, '--tsconfig', SERVER_TSCONFIG, SERVER_MAIN, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: (chunk) => {
        err += chunk;
        out += chunk;
      },
    },
  );
  running.add(child);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, output: () => out, stderr: () => err, exited };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits like the launcher: a lock file whose port answers the health check with the same instance. */
async function waitUntilReady(server: ServerProcess, home: string): Promise<ServerLockFile> {
  const state: { exit: { code: number | null } | null } = { exit: null };
  void server.exited.then((exit) => {
    state.exit = exit;
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (state.exit !== null) {
      throw new Error(
        `server exited with ${String(state.exit.code)} before it was ready:\n${server.output()}`,
      );
    }
    const read = await readServerLock(home);
    if (read.kind === 'ok') {
      const health = await checkHealth(read.lock.port);
      if (health.kind === 'ok' && health.health.serverInstanceId === read.lock.serverInstanceId)
        return read.lock;
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${String(READY_TIMEOUT_MS)} ms`);
    await sleep(200);
  }
}

let cmdCounter = 0;
async function command(client: TestWsClient, cmd: Record<string, unknown>) {
  cmdCounter += 1;
  const cmdId = `00000000-0000-4000-8000-${cmdCounter.toString(16).padStart(12, '0')}`;
  client.send({ type: 'cmd', cmdId, cmd });
  return client.next('ack', (m) => m.cmdId === cmdId, 30_000);
}

/** The first open decision of the entry: from the snapshot, else from the following ops. */
async function firstDecision(
  client: TestWsClient,
  snapshot: Extract<ServerMessage, { type: 'session.snapshot' }>,
): Promise<Decision> {
  const fromSnapshot = snapshot.decisions[0];
  if (fromSnapshot !== undefined) return fromSnapshot;
  const ops = await client.next(
    'session.ops',
    (m) => m.entryId === snapshot.entryId && m.ops.some((o) => o.op.op === 'decision.upsert'),
    30_000,
  );
  for (const { op } of ops.ops) if (op.op === 'decision.upsert') return op.decision;
  throw new Error('no decision');
}

describe('server entry (main.ts) as a process with the FakeBackend', () => {
  it('launcher code → cookie → WS → permission → idle → server.shutdown ends the process', async () => {
    const home = await tempDir('wp20a-main-');
    const cwd = await tempDir('wp20a-cwd-');
    const server = spawnServer(['--backend=fake', '--port=0', `--home=${home}`]);
    const lock = await waitUntilReady(server, home);
    const startedAt = new Date(lock.startedAt);
    expect(lock.pid).not.toBe(server.child.pid); // tsx runs the server in its own child process
    expect(isProcessAlive(lock.pid)).toBe(true);

    // Health without auth, launcher code with the token from the lock file (no Origin).
    const health = await checkHealth(lock.port);
    expect(health).toMatchObject({ kind: 'ok', health: { serverInstanceId: lock.serverInstanceId } });
    const code = await requestLauncherCode(lock.port, lock.launcherToken);
    if (code.kind !== 'ok') throw new Error(`launcher code failed: ${code.kind}`);

    // One-time code → device cookie (as the page does it).
    const origin = serverOrigin(lock.port);
    const login = await rawRequest(lock.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.response.code }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFromSetCookie(login.headers['set-cookie'], authCookieName(lock.port));
    if (cookie === null) throw new Error('no device cookie');

    // WS handshake.
    const connected = await connectWs(
      { port: lock.port, origin, host: `127.0.0.1:${String(lock.port)}` },
      { cookie },
    );
    if (!connected.ok) throw new Error(`ws rejected: ${String(connected.status)} ${connected.body}`);
    const client = connected.client;
    const hello = await client.next('hello');
    expect(hello.serverInstanceId).toBe(lock.serverInstanceId);
    client.send({
      type: 'clientHello',
      protocolVersion: PROTOCOL_VERSION,
      buildId: hello.buildId,
      clientId: sampleId('cl', 1),
      presence: { focused: true, visible: true, viewingEntryId: null, typing: false },
    });
    const host = await client.next('host.state');
    expect(host.host).toMatchObject({ backend: 'fake', dev: false, setupRequired: false });
    await client.next('summaries.snapshot');

    // A session whose first turn asks for a Bash permission (interactive fake scenario).
    const created = await command(client, {
      name: 'session.create',
      cwd,
      prompt: { text: 'fake:permission run the tests' },
    });
    if (!created.ok) throw new Error(`session.create failed: ${created.error.code}`);
    const result: unknown = created.result;
    if (typeof result !== 'object' || result === null || !('entryId' in result))
      throw new Error('session.create without entryId');
    const entryId = entryIdSchema.parse(result.entryId);
    client.send({ type: 'subscribe', entryId });
    const snapshot = await client.next('session.snapshot', (m) => m.entryId === entryId, 30_000);
    const decision = await firstDecision(client, snapshot);
    expect(decision.kind).toBe('permission');

    const answered = await command(client, {
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    expect(answered.ok).toBe(true);
    const idle = await client.next(
      'summary.upsert',
      (m) =>
        m.summary.entryId === entryId &&
        m.summary.status.runState === 'idle' &&
        m.summary.status.lastTurn !== null &&
        m.summary.status.decisions.permission === 0,
      60_000,
    );
    expect(idle.summary.status.errorCode).toBeNull();
    expect(client.invalid).toEqual([]);

    // "Server beenden": ack first, then WS close 4503, the process ends with 0, lock file removed.
    const stopped = await command(client, { name: 'server.shutdown' });
    expect(stopped.ok).toBe(true);
    const closed = await client.closed;
    expect(closed.code).toBe(4503);
    expect(await server.exited).toEqual({ code: SERVER_EXIT_CODES.ok, signal: null });
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
    expect(isProcessAlive(lock.pid)).toBe(false);
    // No child of the server survived (a child keeps its ParentProcessId after the parent's exit).
    const orphans = (await childProcesses(lock.pid)).filter((p) => p.startedAt >= startedAt);
    expect(orphans).toEqual([]);
    // The rotating log file got the whole run, including the last line before the exit.
    const logs = await readdir(path.join(home, 'logs'));
    const logFile = logs.find((name) => /^parallax\..+\.log$/.test(name));
    if (logFile === undefined) throw new Error(`no log file in ${logs.join(', ')}`);
    const log = await readFile(path.join(home, 'logs', logFile), 'utf8');
    expect(log).toContain('"msg":"server listening"');
    expect(log).toContain('"msg":"shutdown: done"');
  });

  it('exit code 3 when a store file was written by a newer Parallax (file unchanged)', async () => {
    const home = await tempDir('wp20a-v3-');
    const registry = path.join(home, 'sessions.json');
    const content = `${JSON.stringify({ schemaVersion: 99, entries: [] })}\n`;
    await writeFile(registry, content);
    const server = spawnServer(['--backend=fake', '--port=0', `--home=${home}`]);
    const exit = await server.exited;
    expect(exit.code, server.output()).toBe(SERVER_EXIT_CODES.storeVersionTooNew);
    const lastLine = server.stderr().trim().split(/\r?\n/).at(-1) ?? '';
    expect(lastLine).toContain('sessions.json was written by a newer Parallax');
    expect(await readFile(registry, 'utf8')).toBe(content);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('exit code 4 when the port is in use', async () => {
    const home = await tempDir('wp20a-port-');
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
    const server = spawnServer(['--backend=fake', `--port=${String(address.port)}`, `--home=${home}`]);
    const exit = await server.exited;
    expect(exit.code, server.output()).toBe(SERVER_EXIT_CODES.portInUse);
    expect(server.stderr()).toContain('EADDRINUSE');
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });
});
