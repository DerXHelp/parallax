/**
 * The launcher flow (Plan "Server-Betrieb", C.2, C.8, C.9; architecture §5.1 (h)/(i), ADR-015):
 *
 * 0. One launcher per data directory at a time (R3-04, ADR-062): a double click waits for the
 *    first launcher (named-pipe lock per home) and then finds its server.
 * 1. Single instance: lock file → `GET /api/health` with the instance UUID (never the PID).
 *    Running → one-time code via `POST /api/launcher/code` → only another Edge window – unless that
 *    server runs another backend than requested (R3-02: clear error instead of a silent window).
 * 2. Otherwise: build `dist` if missing/stale (build id; one build per checkout at a time), check
 *    the port, start the server hidden and detached, wait until its lock file (same PID) and health
 *    answer, then code + window. Exit 5/port taken by a server of this home → wait for it.
 *
 * Every side effect is a dependency (`LauncherDeps`), so all paths are unit-tested; the real ones
 * come from `createNodeLauncherDeps`. Messages are English (console output like `pnpm preflight`).
 */
import {
  appUrlWithCode,
  serverOrigin,
  type BackendKind,
  type HealthResponse,
  type LauncherToken,
  type ServerLockFile,
} from '@shared/http';
import { sleep } from '../lib/async';
import { acquireDirectoryLock, type DirectoryLockKind } from '../lib/homeLock';
import {
  BUILD_STEP_TIMEOUT_MS,
  checkBuild,
  resolveCheckoutBuildId,
  runBuild,
  type BuildResult,
  type BuildState,
} from './build';
import {
  checkHealth,
  findRunningServer,
  requestLauncherCode,
  type HealthCheck,
  type LauncherCodeResult,
  type RunningServerCheck,
} from './client';
import {
  edgeAppArgs,
  edgeProfileDir,
  edgeProfileSignedIn,
  locateEdge,
  openEdgeWindow,
  type SpawnFn,
} from './edgeWindow';
import { SERVER_EXIT_CODES } from './exitCodes';
import { readServerLock, serverLockPath, type LockReadResult } from './lockFile';
import {
  logsDir,
  probePort,
  readServerOutput,
  serverOutLogPath,
  startServerProcess,
  type PortProbe,
  type ServerExit,
  type StartedServer,
} from './serverProcess';

export type LauncherErrorReason =
  | 'build_failed'
  | 'port_in_use'
  | 'port_denied'
  | 'store_too_new'
  | 'server_start_failed'
  | 'server_exited'
  | 'server_timeout'
  | 'launcher_code_failed'
  | 'edge_not_found'
  | 'edge_failed'
  | 'backend_mismatch'
  | 'launch_busy'
  | 'build_busy';

/** A failure with a ready-to-print English message; `exitCode` for the launcher process. */
export class LauncherError extends Error {
  readonly reason: LauncherErrorReason;
  readonly exitCode: number;

  constructor(reason: LauncherErrorReason, message: string) {
    super(message);
    this.name = 'LauncherError';
    this.reason = reason;
    this.exitCode = reason === 'store_too_new' ? SERVER_EXIT_CODES.storeVersionTooNew : 1;
  }
}

/** One try of a cross-process lock (lib/homeLock `acquireDirectoryLock`). */
export type LockAttempt = { kind: 'acquired'; release: () => Promise<void> } | { kind: 'busy' };

export interface LauncherDeps {
  /** R3-04: one launcher per data directory at a time. */
  acquireLaunchLock(home: string): Promise<LockAttempt>;
  /** R3-04: one build per checkout at a time (launchers of other data directories). */
  acquireBuildLock(): Promise<LockAttempt>;
  findRunningServer(home: string): Promise<RunningServerCheck>;
  checkHealth(port: number): Promise<HealthCheck>;
  readLock(home: string): Promise<LockReadResult>;
  requestCode(port: number, token: LauncherToken): Promise<LauncherCodeResult>;
  /** Build id the current checkout would get (null = unknown). */
  expectedBuildId(): Promise<string | null>;
  checkBuild(expected: string | null): Promise<BuildState>;
  runBuild(): Promise<BuildResult>;
  probePort(port: number): Promise<PortProbe>;
  startServer(args: readonly string[]): Promise<StartedServer>;
  /** server.out.log since `offset` (the started server's own output). */
  readServerOutput(offset: number): Promise<string>;
  locateEdge(): Promise<string | null>;
  openEdge(edgePath: string, args: readonly string[]): Promise<{ pid: number | null }>;
  /** Is the Edge profile of `home` signed in to an account (from a version before V2-01)? */
  edgeProfileSignedIn(home: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** One line of console output. */
  out(line: string): void;
}

export interface LauncherOptions {
  /** Absolute PARALLAX_HOME (loadConfig). */
  home: string;
  /** Configured port; 0 = any free port (tests). */
  port: number;
  /** Arguments for `dist/server.js` (`--home=… --port=… --backend=…`). */
  serverArgs: readonly string[];
  /** Check `dist` and build if needed (false: `--no-build`). */
  build: boolean;
  /** Print the URL with the one-time code instead of opening Edge (`--print-url`). */
  printUrl: boolean;
  /**
   * Requested backend (R3-02): a running server with another one is an error, not a window.
   * Absent = not checked.
   */
  backend?: BackendKind;
  /** `--port`/`PARALLAX_PORT` was given (V2-13: the "other port" hint only then; default true). */
  portExplicit?: boolean;
  /** Maximum wait for the started server (default 30 s). */
  readyTimeoutMs?: number;
  /** Maximum wait for another launcher / build of the same folder (default 25 min). */
  lockWaitMs?: number;
  /** Poll interval while waiting (default 150 ms). */
  pollMs?: number;
}

export interface LauncherResult {
  /** `existing`: another window of the running server; `started`: a new server. */
  mode: 'existing' | 'started';
  port: number;
  /** Server PID (from the lock file). */
  pid: number;
  /** Only with `printUrl`. */
  url: string | null;
  /** PID of the started msedge.exe (null with `printUrl`). */
  edgePid: number | null;
}

export const DEFAULT_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_MS = 150;
/** Another launcher may build first: both build steps at their limit plus the server start. */
export const DEFAULT_LOCK_WAIT_MS = 2 * BUILD_STEP_TIMEOUT_MS + 5 * 60_000;

const CHANGE_PORT_HINT = 'Choose another port with --port=<n> or the environment variable PARALLAX_PORT.';

function lastLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line = lines.at(-1);
  if (line === undefined) return null;
  return line.length > 400 ? `${line.slice(0, 400)}...` : line;
}

/** A server that answers for this home (lock file + health of the same instance). */
interface RunningServer {
  lock: ServerLockFile;
  health: HealthResponse;
}

export async function runLauncher(options: LauncherOptions, deps: LauncherDeps): Promise<LauncherResult> {
  const lock = await waitForLock(
    () => deps.acquireLaunchLock(options.home),
    'launch_busy',
    `Parallax is being started for ${options.home} by another launcher - waiting for it...`,
    `Another Parallax launcher for ${options.home} did not finish in time. Close its console window ` +
      '(or end it in the Task Manager) and start Parallax again.',
    options,
    deps,
  );
  try {
    return await launch(options, deps);
  } finally {
    await lock.release();
  }
}

async function launch(options: LauncherOptions, deps: LauncherDeps): Promise<LauncherResult> {
  const found = await deps.findRunningServer(options.home);
  if (found.kind === 'running') return openExisting(found, options, deps);
  if (found.staleLock !== null)
    deps.out('Found a stale lock file of an earlier server - starting a new one.');

  if (options.build) await ensureBuild(options, deps);
  if (options.port !== 0) {
    const winner = await assertPortAvailable(options.port, found, options.home, deps);
    if (winner !== null) return openExisting(winner, options, deps);
  }

  deps.out('Starting the Parallax server in the background...');
  let server: StartedServer;
  try {
    server = await deps.startServer(options.serverArgs);
  } catch (error) {
    throw new LauncherError(
      'server_start_failed',
      `The Parallax server could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ready = await waitForServer(server, options, deps);
  if (ready.mode === 'existing') return openExisting(ready.running, options, deps);
  return openWindow(ready.lock, 'started', options, deps);
}

/**
 * Takes a cross-process lock; if another holder has it, prints `waiting` once and polls until it is
 * free (the other launcher/build finished) or `lockWaitMs` passed.
 */
async function waitForLock(
  acquire: () => Promise<LockAttempt>,
  reason: Extract<LauncherErrorReason, 'launch_busy' | 'build_busy'>,
  waiting: string,
  timeout: string,
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<{ release: () => Promise<void>; waited: boolean }> {
  let attempt = await acquire();
  if (attempt.kind === 'acquired') return { release: attempt.release, waited: false };
  deps.out(waiting);
  const deadline = deps.now() + (options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  for (;;) {
    if (deps.now() >= deadline) throw new LauncherError(reason, timeout);
    await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS);
    attempt = await acquire();
    if (attempt.kind === 'acquired') return { release: attempt.release, waited: true };
  }
}

const BACKEND_LABELS: Readonly<Record<BackendKind, string>> = {
  sdk: 'real claude backend (--backend=sdk)',
  fake: 'FakeBackend (--backend=fake)',
};

/** R3-02: never silently open a window of a server with another backend than requested. */
function assertBackend(running: RunningServer, options: LauncherOptions): void {
  const actual = running.health.backend;
  const requested = options.backend;
  // Servers before R3 do not report their backend: not checked.
  if (requested === undefined || actual === undefined || actual === requested) return;
  throw new LauncherError(
    'backend_mismatch',
    `Parallax already runs for ${options.home} with the ${BACKEND_LABELS[actual]} on port ` +
      `${String(running.lock.port)} (PID ${String(running.lock.pid)}), but the ${BACKEND_LABELS[requested]} ` +
      `was requested. Stop that server first - "parallax --backend=${actual}" opens a window of it, then ` +
      'choose "Stop server" in the menu - and start Parallax again.',
  );
}

async function openExisting(
  running: RunningServer,
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<LauncherResult> {
  assertBackend(running, options);
  // The build id of the checkout takes about a second (git) – do not delay the window for it.
  const [, result] = await Promise.all([
    hintsForRunningServer(running.lock, running.health.buildId, options, deps),
    openWindow(running.lock, 'existing', options, deps),
  ]);
  return result;
}

async function hintsForRunningServer(
  lock: ServerLockFile,
  runningBuildId: string,
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<void> {
  // V2-13: only when a port was asked for – the default port is no request.
  if (options.portExplicit !== false && options.port !== 0 && options.port !== lock.port) {
    deps.out(
      `Parallax already runs on port ${String(lock.port)}; port ${String(options.port)} takes effect after ` +
        '"Stop server" in the Parallax menu and a new start.',
    );
  }
  if (!options.build) return;
  const expected = await deps.expectedBuildId();
  if (expected !== null && expected !== runningBuildId) {
    deps.out(
      `The running server is an older build (${runningBuildId}, checkout: ${expected}). To update, choose ` +
        '"Stop server" in the Parallax menu and start Parallax again.',
    );
  }
}

async function ensureBuild(options: LauncherOptions, deps: LauncherDeps): Promise<void> {
  let state = await deps.checkBuild(await deps.expectedBuildId());
  if (state.upToDate) return;
  // R3-04: a launcher of another data directory may be building the same checkout right now.
  const lock = await waitForLock(
    () => deps.acquireBuildLock(),
    'build_busy',
    'Another build of this Parallax folder is running - waiting for it...',
    'Another build of this Parallax folder did not finish in time. Wait for it or end it, then start ' +
      'Parallax again.',
    options,
    deps,
  );
  try {
    if (lock.waited) {
      state = await deps.checkBuild(await deps.expectedBuildId());
      if (state.upToDate) return;
    }
    deps.out(
      state.reason === 'missing'
        ? 'Building Parallax (first start - this can take a minute)...'
        : 'Building Parallax (the checkout changed since the last build)...',
    );
    const result = await deps.runBuild();
    if (result.ok) return;
    const output = result.output.split(/\r?\n/).slice(-30).join('\n');
    throw new LauncherError(
      'build_failed',
      `The build failed (${result.step}). Run "pnpm build" in the Parallax folder for details.\n${output}`,
    );
  } finally {
    await lock.release();
  }
}

/** Null = the port is free; a running server of THIS home on it = use it (R3-04); else an error. */
async function assertPortAvailable(
  port: number,
  found: RunningServerCheck,
  home: string,
  deps: LauncherDeps,
): Promise<RunningServer | null> {
  const probe = await deps.probePort(port);
  if (probe === 'free') return null;
  if (probe === 'denied') {
    throw new LauncherError(
      'port_denied',
      `Port ${String(port)} cannot be used (access denied - Windows may reserve it; see ` +
        `"netsh interface ipv4 show excludedportrange protocol=tcp"). ${CHANGE_PORT_HINT}`,
    );
  }
  // The server of this home may have come up since the first check (another start, R3-04).
  const again = await deps.findRunningServer(home);
  if (again.kind === 'running') return again;
  throw new LauncherError('port_in_use', await portInUseMessage(port, found, deps));
}

async function portInUseMessage(
  port: number,
  found: RunningServerCheck,
  deps: LauncherDeps,
): Promise<string> {
  const health = await deps.checkHealth(port);
  if (health.kind === 'ok') {
    return (
      `Port ${String(port)} is used by another Parallax server (started ${health.health.startedAt}) that ` +
      'does not belong to this data directory. If it is yours, stop it in its window ("Stop server"); ' +
      CHANGE_PORT_HINT
    );
  }
  const stale = found.kind === 'none' ? found.staleLock : null;
  if (stale !== null && stale.port === port) {
    return (
      `Port ${String(port)} is in use, but the Parallax server there does not answer. A hanging earlier ` +
      `server (PID ${String(stale.pid)} from the lock file) may hold it - if that PID is still a node.exe, ` +
      `end it with "taskkill /PID ${String(stale.pid)} /T /F". Otherwise: ${CHANGE_PORT_HINT}`
    );
  }
  return `Port ${String(port)} is already in use by another program. ${CHANGE_PORT_HINT}`;
}

type ServerReady = { mode: 'started'; lock: ServerLockFile } | { mode: 'existing'; running: RunningServer };

async function waitForServer(
  server: StartedServer,
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<ServerReady> {
  const state: { exit: ServerExit | null } = { exit: null };
  void server.exited.then((exit) => {
    state.exit = exit;
  });
  const deadline = deps.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    if (state.exit !== null) return handleExit(state.exit, server, deadline, options, deps);
    const read = await deps.readLock(options.home);
    if (read.kind === 'ok' && read.lock.pid === server.pid) {
      const health = await deps.checkHealth(read.lock.port);
      if (health.kind === 'ok' && health.health.serverInstanceId === read.lock.serverInstanceId) {
        return { mode: 'started', lock: read.lock };
      }
    }
    if (deps.now() >= deadline) {
      throw new LauncherError(
        'server_timeout',
        `The Parallax server (PID ${String(server.pid)}) did not become ready within ` +
          `${String(Math.round((options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000))} s. ` +
          `It may still be starting - see ${serverOutLogPath(options.home)} and ` +
          `${logsDir(options.home)}\\parallax.*.log, then start Parallax again.`,
      );
    }
    await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** Polls the single-instance check until a server of this home answers or `deadline` passed. */
async function waitForWinner(
  options: LauncherOptions,
  deps: LauncherDeps,
  deadline: number,
): Promise<RunningServer | null> {
  for (;;) {
    const winner = await deps.findRunningServer(options.home);
    if (winner.kind === 'running') return winner;
    if (deps.now() >= deadline) return null;
    await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }
}

/**
 * The started server ended. Port taken (4/EADDRINUSE) or "already running" (5) can mean that
 * another start for this home won the race (double click, a manual `node dist/server.js`): that
 * server may still be starting (stores, recovery, listen) – it is polled until the ready deadline
 * and then used ("existing", R3-04).
 */
async function handleExit(
  exit: ServerExit,
  server: StartedServer,
  deadline: number,
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<ServerReady> {
  let output = await deps.readServerOutput(server.outLogOffset);
  if (output === '') {
    // The file may still be held (scanner) or not yet visible right after the exit: once more.
    await deps.sleep(250);
    output = await deps.readServerOutput(server.outLogOffset);
  }
  const last = lastLine(output);
  const detail = last === null ? '' : `\nServer output: ${last}`;
  if (exit.code === SERVER_EXIT_CODES.storeVersionTooNew) {
    throw new LauncherError(
      'store_too_new',
      `The data in ${options.home} was written by a newer Parallax version. Update Parallax (git pull, ` +
        `pnpm install) and start it again - the files were left unchanged.${detail}`,
    );
  }
  const portInUse = exit.code === SERVER_EXIT_CODES.portInUse || /\bEADDRINUSE\b/.test(output);
  if (portInUse || exit.code === SERVER_EXIT_CODES.alreadyRunning) {
    const winner = await waitForWinner(options, deps, deadline);
    if (winner !== null) return { mode: 'existing', running: winner };
  }
  if (portInUse) {
    throw new LauncherError(
      'port_in_use',
      `The Parallax server could not listen on port ${String(options.port)}: the port is already in use. ` +
        CHANGE_PORT_HINT,
    );
  }
  if (exit.code === SERVER_EXIT_CODES.alreadyRunning) {
    throw new LauncherError(
      'server_exited',
      `Another Parallax server for ${options.home} is starting or stopping right now - start Parallax again ` +
        `in a moment.${detail}`,
    );
  }
  const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `exit code ${String(exit.code)}`;
  throw new LauncherError(
    'server_exited',
    `The Parallax server stopped right after the start (${how}). Details: ${serverOutLogPath(options.home)} ` +
      `and ${logsDir(options.home)}\\parallax.*.log.${detail}`,
  );
}

/**
 * Waits before the 2nd/3rd/4th code request (R2-14): right after its start the server is busy
 * (recovery, orphan check, Edge) and a single 2-s request may time out. Never for `token_invalid`.
 */
export const CODE_RETRY_DELAYS_MS: readonly number[] = [250, 750, 1_500];

async function requestCodeWithRetry(lock: ServerLockFile, deps: LauncherDeps): Promise<LauncherCodeResult> {
  let code = await deps.requestCode(lock.port, lock.launcherToken);
  for (const delay of CODE_RETRY_DELAYS_MS) {
    if (code.kind !== 'failed') return code;
    await deps.sleep(delay);
    code = await deps.requestCode(lock.port, lock.launcherToken);
  }
  return code;
}

async function openWindow(
  lock: ServerLockFile,
  mode: LauncherResult['mode'],
  options: LauncherOptions,
  deps: LauncherDeps,
): Promise<LauncherResult> {
  const code = await requestCodeWithRetry(lock, deps);
  if (code.kind !== 'ok') {
    throw new LauncherError(
      'launcher_code_failed',
      code.kind === 'token_invalid'
        ? `The server on port ${String(lock.port)} rejected the launcher token from ` +
            `${serverLockPath(options.home)} (the lock file belongs to another server). Stop that server ` +
            '("Stop server" in its window) and start Parallax again.'
        : `No sign-in code from the server on port ${String(lock.port)} (${code.reason}). Start Parallax again.`,
    );
  }
  const url = appUrlWithCode(serverOrigin(lock.port), code.response.code);
  const base = { mode, port: lock.port, pid: lock.pid };
  if (options.printUrl) {
    deps.out(`Open this address within 60 seconds (one-time sign-in code): ${url}`);
    return { ...base, url, edgePid: null };
  }
  const edge = await deps.locateEdge();
  if (edge === null) {
    throw new LauncherError(
      'edge_not_found',
      `Microsoft Edge was not found (App Paths in HKCU/HKLM, Program Files). The Parallax server runs on ` +
        `port ${String(lock.port)} (PID ${String(lock.pid)}). Install Edge, or start the launcher with ` +
        '--print-url and open the printed address in a Chromium-based browser within 60 seconds.',
    );
  }
  if (await deps.edgeProfileSignedIn(options.home)) {
    // V2-01: new profiles never sign in; one from an earlier version may still be (sync stays off).
    deps.out(
      `Note: the Parallax Edge profile (${edgeProfileDir(options.home)}) is signed in to an account from an ` +
        'earlier Parallax version. Sync stays off; to remove the account, sign out in that window ' +
        '(... > Settings > Profiles) or close all Parallax windows and delete that folder.',
    );
  }
  try {
    const { pid } = await deps.openEdge(edge, edgeAppArgs({ home: options.home, url }));
    return { ...base, url: null, edgePid: pid };
  } catch (error) {
    throw new LauncherError(
      'edge_failed',
      `Microsoft Edge (${edge}) could not be started: ${error instanceof Error ? error.message : String(error)}. ` +
        'Company policies may block --user-data-dir or app windows.',
    );
  }
}

export interface NodeLauncherDepsOptions {
  /** Repo root (dist/, node_modules/, repo.config.ts). */
  repoRoot: string;
  home: string;
  /** Absolute path of the server entry (`<repo>/dist/server.js`). */
  serverScript: string;
  /** node.exe for build and server (default process.execPath). */
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  /** Edge spawn (default lib/process spawnHidden, see edgeWindow.ts). */
  spawnEdge?: SpawnFn;
}

/** One non-blocking try of the named-pipe lock `kind` of `dir` (held until released or exit). */
async function tryDirectoryLock(kind: DirectoryLockKind, dir: string): Promise<LockAttempt> {
  const result = await acquireDirectoryLock(kind, dir);
  if (result.kind === 'busy') return { kind: 'busy' };
  const lock = result.lock;
  return { kind: 'acquired', release: () => lock.release() };
}

/** The real dependencies (file system, HTTP on 127.0.0.1, spawn, registry, clock). */
export function createNodeLauncherDeps(options: NodeLauncherDepsOptions): LauncherDeps {
  const nodePath = options.nodePath ?? process.execPath;
  const env = options.env ?? process.env;
  return {
    acquireLaunchLock: (home) => tryDirectoryLock('launch', home),
    acquireBuildLock: () => tryDirectoryLock('build', options.repoRoot),
    findRunningServer: (home) => findRunningServer({ home }),
    checkHealth: (port) => checkHealth(port),
    readLock: (home) => readServerLock(home),
    requestCode: (port, token) => requestLauncherCode(port, token),
    expectedBuildId: () => resolveCheckoutBuildId(options.repoRoot),
    checkBuild: (expected) => checkBuild({ repoRoot: options.repoRoot, expected }),
    runBuild: () => runBuild({ repoRoot: options.repoRoot, nodePath, env }),
    probePort,
    startServer: (args) =>
      startServerProcess({
        nodePath,
        serverScript: options.serverScript,
        args,
        home: options.home,
        cwd: options.repoRoot,
        env,
      }),
    readServerOutput: (offset) => readServerOutput(options.home, offset),
    locateEdge: () => locateEdge(env),
    openEdge: (edgePath, args) => openEdgeWindow(edgePath, args, options.spawnEdge),
    edgeProfileSignedIn: (home) => edgeProfileSignedIn(home),
    sleep,
    now: () => Date.now(),
    out: options.out ?? ((line) => process.stdout.write(`${line}\n`)),
  };
}
