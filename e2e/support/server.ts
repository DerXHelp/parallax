/**
 * A real Parallax server for the E2E tests: `node dist/server.js --backend=fake --port=0
 * --home=<tmp>` (FakeBackend with the interactive dev scenario, docs/wp/WP-13a.md), started and
 * awaited like the launcher does it (lock file + health with the same instance, WP-21), signed in
 * like the launcher (one-time code over `POST /api/launcher/code` with the token from the lock
 * file → `/#code=…`). `stop()` ends it with the WS command `server.shutdown` (the "Stop server"
 * path) and checks the clean exit: exit code 0, lock file gone, process dead, no child process.
 *
 * `NODE_ENV=test` makes the hub and the transcript store validate every outgoing value with
 * `throw` (src/server/sync/hub.ts) – contract slips at the server ↔ web seam fail loudly; the
 * server log is checked for error lines when the server stops.
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appUrlWithCode, authCookieName, serverOrigin, type ServerLockFile } from '@shared/http';
import type { Settings } from '@shared/model';
import { PROTOCOL_VERSION } from '@shared/protocol';
import {
  connectWs,
  cookieFromSetCookie,
  rawRequest,
  type TestWsClient,
} from '../../src/server/http/testServer';
import { checkHealth, requestLauncherCode } from '../../src/server/launcher/client';
import { readServerLock } from '../../src/server/launcher/lockFile';
import { childProcesses, isProcessAlive, killProcessTree, spawnHidden } from '../../src/server/lib/process';
import { REPO_ROOT, SERVER_BUNDLE } from './paths';

const READY_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;
/**
 * One sign-in code request of a test (`POST /api/launcher/code`). The launcher's default is its
 * health-ping budget (2 s, `HEALTH_TIMEOUT_MS`: "a running server answers in a few ms") – a
 * wall-clock assumption of an idle machine. With `pnpm test` running next to three workers the
 * answer took longer and a test failed with "launcher code failed: failed" (FIX-R4-F5 §3). A test
 * waits like for any other answer of the server (`nodeCommand`: 30 s).
 */
const LAUNCHER_CODE_TIMEOUT_MS = 30_000;

export interface ExitResult {
  code: number | null;
  signal: string | null;
}

/** pino levels in the JSON log file: 50 = error, 60 = fatal. */
const ERROR_LEVEL = 50;

export interface E2eServer {
  /** Temp folder with `home/` (PARALLAX_HOME) and the project folders of the tests. */
  readonly root: string;
  readonly home: string;
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly lock: ServerLockFile;
  readonly pid: number;
  readonly startedAt: Date;
  /** stdout + stderr of the server process so far. */
  output(): string;
  /** A fresh sign-in URL `<origin>/#code=<one-time code>` (plus an optional rest hash). */
  loginUrl(hash?: string): Promise<string>;
  /** A device cookie `parallax_<port>=…` for node-side clients (code exchanged like the page). */
  deviceCookie(): Promise<string>;
  /** A new, existing project folder (`cwd` of a session). */
  makeProject(name: string): Promise<string>;
  /** Resolves when the process has exited. */
  readonly exited: Promise<ExitResult>;
  /** `server.shutdown` over a node WS client (ack → close 4503). */
  requestShutdown(): Promise<void>;
  /**
   * Waits for the exit and checks it was clean: code 0, lock file removed, PID dead, no child
   * process of the server left, no error line in the server log.
   */
  assertCleanExit(): Promise<void>;
  /**
   * requestShutdown + assertCleanExit (if still running) and removes the temp folder; `keepLog`
   * gets the server log before (e.g. to keep it as an artifact).
   */
  stop(keepLog?: (lines: string[]) => Promise<void>): Promise<void>;
  /** Kills the process tree (cleanup after a failure). */
  kill(): Promise<void>;
  /** The JSON lines of the rotating server log. */
  logLines(): Promise<string[]>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Env of the server: no PARALLAX_* or Vitest leftovers of the caller, validation on. */
function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PARALLAX_') || key === 'VITEST' || key.startsWith('VITEST_')) continue;
    env[key] = value;
  }
  env.NODE_ENV = 'test';
  return env;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} timed out after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StartServerOptions {
  /** Prefix of the temp folder (diagnostics). */
  label?: string;
  /**
   * Restart on the temp folder of an earlier server of this test (same PARALLAX_HOME and projects,
   * e.g. "open plan card at shutdown → needs-resume after the restart"). That server must have
   * exited (`requestShutdown` + `assertCleanExit`, not `stop()` – it removes the folder).
   */
  reuse?: Pick<E2eServer, 'root' | 'home'>;
}

export async function startE2eServer(options: StartServerOptions = {}): Promise<E2eServer> {
  const root =
    options.reuse?.root ?? (await mkdtemp(path.join(os.tmpdir(), `parallax-e2e-${options.label ?? 'srv'}-`)));
  const home = options.reuse?.home ?? path.join(root, 'home');
  if (options.reuse === undefined) await mkdir(home);
  const startedAt = new Date(Date.now() - 1000);
  let out = '';
  const child: ChildProcess = spawnHidden(
    process.execPath,
    [SERVER_BUNDLE, '--backend=fake', '--port=0', `--home=${home}`],
    {
      cwd: REPO_ROOT,
      env: serverEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: (chunk) => {
        out += chunk;
      },
    },
  );
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  const exitState: { result: ExitResult | null } = { result: null };
  const exited = new Promise<ExitResult>((resolve) => {
    child.once('exit', (code, signal) => {
      exitState.result = { code, signal };
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      out += `\nspawn error: ${error.message}`;
      exitState.result = { code: null, signal: null };
      resolve({ code: null, signal: null });
    });
  });

  // Ready like the launcher: a lock file of this process whose port answers with the same instance.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exitState.result !== null) {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
      throw new Error(`server exited with ${String(exitState.result.code)} before it was ready:\n${out}`);
    }
    const read = await readServerLock(home);
    if (read.kind === 'ok' && read.lock.pid === child.pid) {
      const health = await checkHealth(read.lock.port);
      if (health.kind === 'ok' && health.health.serverInstanceId === read.lock.serverInstanceId) {
        return serverHandle({ root, home, lock: read.lock, startedAt, exited, exitState, output: () => out });
      }
    }
    if (Date.now() > deadline) {
      if (child.pid !== undefined) await killProcessTree(child.pid);
      throw new Error(`server not ready after ${String(READY_TIMEOUT_MS)} ms:\n${out}`);
    }
    await sleep(100);
  }
}

/**
 * A server started by someone else (the launcher, `pnpm start`) for `home`: ready like the
 * launcher waits; its exit code is unknown (not our child) – `exited` resolves with `code: null`
 * once the PID is gone.
 */
export async function adoptE2eServer(options: {
  root: string;
  home: string;
  startedAt: Date;
}): Promise<E2eServer> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const read = await readServerLock(options.home);
    if (read.kind === 'ok') {
      const health = await checkHealth(read.lock.port);
      if (health.kind === 'ok' && health.health.serverInstanceId === read.lock.serverInstanceId) {
        const lock = read.lock;
        const exitState: { result: ExitResult | null } = { result: null };
        const exited = (async () => {
          while (isProcessAlive(lock.pid)) await sleep(200);
          exitState.result = { code: null, signal: null };
          return exitState.result;
        })();
        return serverHandle({ ...options, lock, exited, exitState, output: () => '' });
      }
    }
    if (Date.now() > deadline) throw new Error(`no ready server for ${options.home}`);
    await sleep(200);
  }
}

interface HandleParts {
  root: string;
  home: string;
  lock: ServerLockFile;
  startedAt: Date;
  exited: Promise<ExitResult>;
  exitState: { result: ExitResult | null };
  output: () => string;
}

function serverHandle(parts: HandleParts): E2eServer {
  const { root, home, startedAt, exited, exitState } = parts;
  const ready = parts.lock;
  const out = parts.output;
  const origin = serverOrigin(ready.port);
  let projects = 0;
  let stopped = false;

  /** A one-time sign-in code (like the launcher, with the test's budget); the reason on failure. */
  const launcherCode = async (): Promise<string> => {
    const code = await requestLauncherCode(ready.port, ready.launcherToken, {
      timeoutMs: LAUNCHER_CODE_TIMEOUT_MS,
    });
    if (code.kind === 'ok') return code.response.code;
    throw new Error(`launcher code failed: ${code.kind === 'failed' ? code.reason : code.kind}`);
  };

  const server: E2eServer = {
    root,
    home,
    port: ready.port,
    origin,
    lock: ready,
    pid: ready.pid,
    startedAt,
    exited,
    output: out,
    async loginUrl(hash = '') {
      const url = appUrlWithCode(origin, await launcherCode());
      return hash === '' ? url : `${url}&${hash.replace(/^#/, '')}`;
    },
    async deviceCookie() {
      const code = await launcherCode();
      const login = await rawRequest(ready.port, {
        method: 'POST',
        path: '/api/auth',
        headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const cookie = cookieFromSetCookie(login.headers['set-cookie'], authCookieName(ready.port));
      if (login.status !== 200 || cookie === null) throw new Error(`code exchange failed: ${login.body}`);
      return cookie;
    },
    async makeProject(name) {
      projects += 1;
      const dir = path.join(root, `${String(projects).padStart(2, '0')}-${name}`);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async requestShutdown() {
      const client = await connectNodeClient(server);
      try {
        client.send({ type: 'cmd', cmdId: randomUUID(), cmd: { name: 'server.shutdown' } });
        await client.next('ack', () => true, 15_000);
        const closed = await withTimeout(client.closed, 15_000, 'WS close after server.shutdown');
        if (closed.code !== 4503) throw new Error(`unexpected close ${String(closed.code)} ${closed.reason}`);
      } finally {
        client.socket.terminate();
      }
    },
    async assertCleanExit() {
      const exit = await withTimeout(exited, EXIT_TIMEOUT_MS, 'server exit');
      stopped = true;
      // null: adopted server (not our child), the exit code is unknown.
      if (exit.code !== 0 && exit.code !== null) {
        throw new Error(`server exited with ${String(exit.code)}:\n${out()}`);
      }
      const lockAfter = await readServerLock(home);
      if (lockAfter.kind !== 'missing') throw new Error(`lock file left behind: ${lockAfter.kind}`);
      if (isProcessAlive(ready.pid)) throw new Error(`server PID ${String(ready.pid)} still alive`);
      // A child keeps its ParentProcessId after the parent's exit; younger than the start = ours.
      const children = await childProcesses(ready.pid);
      if (children.kind === 'unknown') {
        throw new Error(`child processes unknown: ${children.reason} ${children.detail}`);
      }
      const orphans = children.processes.filter((p) => p.startedAt >= startedAt);
      if (orphans.length > 0) {
        for (const orphan of orphans) await killProcessTree(orphan.pid);
        throw new Error(
          `child processes left: ${orphans.map((p) => `${p.name} ${String(p.pid)}`).join(', ')}`,
        );
      }
      const errors = (await server.logLines()).filter((line) => logLevel(line) >= ERROR_LEVEL);
      if (errors.length > 0) throw new Error(`server log has error lines:\n${errors.join('\n')}`);
    },
    async stop(keepLog) {
      try {
        if (!stopped && exitState.result === null) {
          await server.requestShutdown();
          await server.assertCleanExit();
        }
      } finally {
        await server.kill();
        if (keepLog !== undefined) await keepLog(await server.logLines());
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
    async kill() {
      if (exitState.result === null && isProcessAlive(ready.pid)) await killProcessTree(ready.pid);
    },
    async logLines() {
      const dir = path.join(home, 'logs');
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const lines: string[] = [];
      for (const name of names.filter((n) => /^parallax\..+\.log$/.test(n)).sort()) {
        const text = await readFile(path.join(dir, name), 'utf8');
        lines.push(...text.split(/\r?\n/).filter((line) => line.trim() !== ''));
      }
      return lines;
    },
  };
  return server;
}

function logLevel(line: string): number {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'level' in parsed &&
      typeof parsed.level === 'number'
    )
      return parsed.level;
  } catch {
    // not JSON (pretty output) – ignore
  }
  return 0;
}

/** Sends a command over a node client and returns its `ack` (throws on `ok: false`). */
export async function nodeCommand(client: TestWsClient, cmd: Record<string, unknown>): Promise<unknown> {
  const cmdId = randomUUID();
  client.send({ type: 'cmd', cmdId, cmd });
  const ack = await client.next('ack', (m) => m.cmdId === cmdId, 30_000);
  if (!ack.ok) throw new Error(`${String(cmd.name)} failed: ${ack.error.code}`);
  return ack.result;
}

/** A node-side protocol client (signed in, handshake done) – e.g. for `server.shutdown`. */
export async function connectNodeClient(server: E2eServer): Promise<TestWsClient> {
  const cookie = await server.deviceCookie();
  const connected = await connectWs(
    { port: server.port, origin: server.origin, host: `127.0.0.1:${String(server.port)}` },
    { cookie },
  );
  if (!connected.ok) throw new Error(`ws rejected: ${String(connected.status)} ${connected.body}`);
  const client = connected.client;
  const hello = await client.next('hello');
  client.send({
    type: 'clientHello',
    protocolVersion: PROTOCOL_VERSION,
    buildId: hello.buildId,
    clientId: `cl_${randomBytes(16).toString('hex')}`,
    presence: { focused: false, visible: false, viewingEntryId: null, typing: false },
  });
  await client.next('summaries.snapshot');
  return client;
}

/**
 * The settings the server has stored – from the `host.state` of a fresh node client's handshake
 * (sent before `summaries.snapshot`), not the page's optimistic view (R4W-27). The client never
 * had the focus, so it is never the target of a notification.
 */
export async function serverSettings(server: E2eServer): Promise<Settings> {
  const client = await connectNodeClient(server);
  try {
    const state = client.all('host.state').at(-1);
    if (state === undefined) throw new Error('no host.state in the handshake');
    return state.host.settings;
  } finally {
    client.socket.terminate();
  }
}
