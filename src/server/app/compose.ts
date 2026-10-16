/**
 * Composition root of the server (WP-20a; docs/architecture.md "Komposition und Start-Reihenfolge").
 * `main.ts` loads the config and the logging, then calls `startServer()`:
 *
 *  1. Single instance per PARALLAX_HOME: a live server behind `server.lock.json` → exit 5.
 *  2. Stores (registry, settings, processes, auth secret; blobs/decisions/transcripts lazily) –
 *     a file of a newer Parallax (`StoreVersionTooNewError`) → exit 3, files unchanged (ADR-020).
 *  3. Backend by `config.backend`: `fake` = FakeBackend (interactive dev scenario) + fake Claude
 *     integration (no `claude` process at all); `sdk` = SdkBackend (the SDK module is only imported
 *     here) + real Claude integration (profile "Standard", resolveClaude).
 *  4. SessionManager → SyncHub(source: manager) → `attachPublisher` → `manager.start()` (recovery;
 *     orphans in the background) → snapshot of the built UI in `PARALLAX_HOME/ui/<buildId>`
 *     (webSnapshot.ts, V2-03) → `createApp` (the app attaches the hub's WS route itself).
 *     Hub and transcript store validate outgoing values with `config.validation` (R3-05).
 *  5. Shutdown frame + signal handlers, then `listen` on 127.0.0.1 (EADDRINUSE → exit 4).
 *  6. `server.lock.json` with the actual port and `auth.launcherToken` – only now the launcher
 *     regards the server as ready; then in the background the access check of the home
 *     (`logHomeAccess`, R2-13) and "Profil testen" of the default profile.
 *
 * The exclusive home lock (R2-05) is taken by main.ts before logging and stores (`homeLock`).
 *
 * Shutdown (command `server.shutdown`, SIGINT/SIGTERM/SIGBREAK/SIGHUP): `manager.shutdown()` (close
 * all queries ≤ 15 s, taskkill after 5 s grace, flush, `backend.dispose()`) → `app.close()` (WS
 * close 4503) → close the stores → wait for the access check → release the lock file → release
 * the home lock → close the log → `exit(code)`.
 */
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { serverOrigin } from '@shared/http';
import { createFakeBackend } from '../backend/fakeBackend';
import { createFakeClaudeIntegration } from '../backend/fake/integration';
import type { AgentBackend } from '../backend/types';
import { createClaudeIntegration } from '../claude/integration';
import type { ClaudeIntegration } from '../claude/ports';
import { readSdkManifest } from '../claude/resolveClaude';
import { createServerInstance, type ServerConfig, type ServerInstance } from '../config';
import { createApp } from '../http/app';
import { createAuthService, type AuthService } from '../http/auth';
import { findRunningServer, type RunningServerCheck } from '../launcher/client';
import { SERVER_EXIT_CODES } from '../launcher/exitCodes';
import { writeServerLock, type ServerLockHandle } from '../launcher/lockFile';
import {
  createServerShutdown,
  type ServerShutdown,
  type ShutdownStep,
  type SignalTarget,
} from '../launcher/shutdown';
import { settleWithin, toError } from '../lib/async';
import { logHomeAccess } from '../lib/homeAccess';
import type { HomeLock } from '../lib/homeLock';
import { logger as rootLogger, type LoggingHandle } from '../lib/logger';
import { errnoCode } from '../lib/process';
import { createSessionManager, SHUTDOWN_SWEEP_GRACE_MS, type SessionManager } from '../sessions/manager';
import { createNativeToasts } from '../sessions/nativeToasts';
import { openProcessStore } from '../sessions/processStore';
import { createBlobStore } from '../store/blobs';
import { createDecisionStore } from '../store/decisions';
import { StoreVersionTooNewError, createStoreWarnings, type StoreWarningRegistry } from '../store/jsonStore';
import { openRegistryStore } from '../store/registry';
import { openSettingsStore } from '../store/settings';
import { createTranscriptStore } from '../store/transcripts';
import { createSyncHub } from '../sync/hub';
import { prepareWebRoot } from './webSnapshot';

/** The server start failed before it was ready; `exitCode` from SERVER_EXIT_CODES. */
export class StartupError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StartupError';
    this.exitCode = exitCode;
  }
}

/** FakeBackend timing of a real server: recorded timing (WP-13a; tests pass 0). */
export const DEFAULT_FAKE_SPEED = 1;
/** Bound of every cleanup step after a failed start (the shutdown frame has its own bounds). */
const CLEANUP_STEP_TIMEOUT_MS = 5_000;
/** The log file gets this long to flush before the process exits. */
const LOG_CLOSE_TIMEOUT_MS = 2_000;

export interface StartServerOptions {
  config: ServerConfig;
  /**
   * Built web UI (`dist/web`); null = not served (dev mode: Vite serves the UI). Served from its
   * snapshot in `PARALLAX_HOME/ui/<buildId>` (webSnapshot.ts) when it carries the server's build id.
   */
  webRoot: string | null;
  /** Closed after the shutdown steps, right before `exit` (so the last lines reach the file). */
  logging?: LoggingHandle | null;
  /** Ends the process after the shutdown (default `process.exit`). */
  exit?: (code: number) => void;
  /** Signal source of the shutdown (default `process`); null = no handlers (in-process tests). */
  signals?: SignalTarget | null;
  /** FakeBackend speed (default 1); in-process tests use 0. */
  fakeSpeed?: number;
  /** Single-instance check (default `findRunningServer` over lock file + health). */
  findRunning?: (home: string) => Promise<RunningServerCheck>;
  /**
   * Exclusive lock of PARALLAX_HOME (R2-05), taken by main.ts BEFORE logging and the stores;
   * released as the shutdown step after the lock file. null/absent = none (in-process tests).
   */
  homeLock?: HomeLock | null;
  /**
   * Check of the home's access rights after `listen`, in the background (default
   * `logHomeAccess`, R2-13: only a warning); null = skipped (in-process tests).
   */
  homeAccess?: ((home: string) => Promise<unknown>) | null;
  /**
   * CR-10: called once the shutdown frame exists (step 5, before `listen`). main.ts hands it to
   * the crash handler, so an unexpected error from here on ends the server in order (stores
   * flushed, lock file removed) – also while `startServer` has not returned yet.
   */
  onShutdownFrame?: (shutdown: ServerShutdown) => void;
  logger?: Logger;
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly instance: ServerInstance;
  /** Actual port (also with `--port=0`). */
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly app: FastifyInstance;
  readonly auth: AuthService;
  readonly manager: SessionManager;
  readonly backend: AgentBackend;
  readonly lock: ServerLockHandle;
  readonly shutdown: ServerShutdown;
}

interface Stores {
  warnings: StoreWarningRegistry;
  registry: Awaited<ReturnType<typeof openRegistryStore>>;
  settings: Awaited<ReturnType<typeof openSettingsStore>>;
  processes: Awaited<ReturnType<typeof openProcessStore>>;
  auth: AuthService;
  blobs: ReturnType<typeof createBlobStore>;
  decisions: ReturnType<typeof createDecisionStore>;
  transcripts: ReturnType<typeof createTranscriptStore>;
  /** Closes every store (errors are logged, never thrown). */
  close(): Promise<void>;
}

/** Settles within `ms` and never rejects (cleanup must go on after a failing step). */
async function settle(work: () => unknown, ms: number, log: Logger, what: string): Promise<void> {
  const settled = await settleWithin(work, ms);
  if (settled.outcome === 'timeout') log.warn({ step: what, ms }, 'cleanup step timed out');
  if (settled.outcome === 'failed') log.warn({ err: settled.error, step: what }, 'cleanup step failed');
}

function errorText(error: unknown): string {
  return toError(error).message;
}

/**
 * Opens the stores in a fixed order; nothing is written before its file was read. A failure closes
 * the stores opened so far and rethrows (StoreVersionTooNewError unchanged).
 */
async function openStores(config: ServerConfig, instance: ServerInstance, log: Logger): Promise<Stores> {
  const home = config.home;
  const warnings = createStoreWarnings();
  const opened: { name: string; close: () => Promise<void> }[] = [];
  const closeOpened = async () => {
    for (const store of [...opened].reverse()) {
      await settle(() => store.close(), CLEANUP_STEP_TIMEOUT_MS, log, store.name);
    }
  };
  try {
    const registry = await openRegistryStore({ home, warnings });
    opened.push({ name: 'registry', close: () => registry.close() });
    const settings = await openSettingsStore({ home, warnings });
    opened.push({ name: 'settings', close: () => settings.close() });
    const processes = await openProcessStore({ home, warnings });
    opened.push({ name: 'processes', close: () => processes.close() });
    const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId, warnings });
    opened.push({ name: 'auth', close: () => auth.close() });
    const blobs = createBlobStore({ home });
    opened.push({ name: 'blobs', close: () => blobs.close() });
    const decisions = createDecisionStore({ home, warnings });
    opened.push({ name: 'decisions', close: () => decisions.close() });
    // Invalid lines are logged and counted, also in production (R1-16, R3-05); tests: throw.
    const transcripts = createTranscriptStore({ home, warnings, validation: config.validation });
    opened.push({ name: 'transcripts', close: () => transcripts.close() });
    return {
      warnings,
      registry,
      settings,
      processes,
      auth,
      blobs,
      decisions,
      transcripts,
      close: closeOpened,
    };
  } catch (error) {
    await closeOpened();
    throw error;
  }
}

interface Engine {
  backend: AgentBackend;
  claude: ClaudeIntegration;
}

/**
 * `fake`: no `claude` process at all (dev, E2E, smoke tests of the launcher path). `sdk`: the SDK
 * module is loaded only here (dynamic import), the Claude integration resolves the real `claude`.
 */
async function createEngine(
  config: ServerConfig,
  instance: ServerInstance,
  fakeSpeed: number,
): Promise<Engine> {
  if (config.backend === 'fake') {
    return { backend: createFakeBackend({ speed: fakeSpeed }), claude: createFakeClaudeIntegration() };
  }
  const { createSdkBackend, loadAgentSdk } = await import('../backend/sdkBackend');
  await loadAgentSdk();
  return {
    backend: createSdkBackend(),
    claude: createClaudeIntegration({ appVersion: instance.serverVersion }),
  };
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { config } = options;
  const log = (options.logger ?? rootLogger).child({ module: 'app' });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const findRunning = options.findRunning ?? ((home: string) => findRunningServer({ home }));

  // 1. Single instance per data directory (a second writer would corrupt the stores). Since the
  //    home lock of main.ts (R2-05) this is belt and braces: it still catches a running server of a
  //    build before the home lock, which does not hold the pipe (R3-11).
  const running = await findRunning(config.home);
  if (running.kind === 'running') {
    throw new StartupError(
      SERVER_EXIT_CODES.alreadyRunning,
      `Another Parallax server already runs for ${config.home} (port ${String(running.lock.port)}, ` +
        `PID ${String(running.lock.pid)}).`,
    );
  }
  if (running.staleLock !== null) log.info({ pid: running.staleLock.pid }, 'stale lock file found');

  // 2. Stores before anything else (R1-06, ADR-020).
  const instance = createServerInstance();
  let stores: Stores;
  try {
    stores = await openStores(config, instance, log);
  } catch (error) {
    if (error instanceof StoreVersionTooNewError) {
      throw new StartupError(SERVER_EXIT_CODES.storeVersionTooNew, error.message, { cause: error });
    }
    throw new StartupError(
      SERVER_EXIT_CODES.failure,
      `The data in ${config.home} could not be opened: ${errorText(error)}`,
      { cause: error },
    );
  }

  // 3.–4. Engine, hub, app. From here on a failure runs the same cleanup as the shutdown.
  let engine: Engine | null = null;
  let manager: SessionManager | null = null;
  let app: FastifyInstance | null = null;
  let lock: ServerLockHandle | null = null;
  let shutdown: ServerShutdown | null = null;
  let uninstallSignals: (() => void) | null = null;
  /** The background access check of the home (its PowerShell must not outlive the server). */
  let accessCheck: Promise<unknown> | null = null;
  const homeLock = options.homeLock ?? null;

  /**
   * The close steps after `manager.shutdown()` (order: architecture "Komposition"). No backend
   * step: `manager.shutdown()` disposes the backend (one owner, R2-06).
   */
  const steps: ShutdownStep[] = [
    { name: 'http', run: () => app?.close() },
    { name: 'stores', run: () => stores.close(), timeoutMs: 10_000 },
    { name: 'homeAccess', run: () => accessCheck },
    { name: 'lock', run: () => lock?.release() },
    // After the lock file: from here on another server may open this home (R2-05).
    { name: 'homeLock', run: () => homeLock?.release() },
  ];

  const cleanupAfterFailure = async (): Promise<void> => {
    uninstallSignals?.();
    if (manager !== null) {
      const stopping = manager;
      await settle(() => stopping.shutdown(), 20_000, log, 'sessions');
    } else if (engine !== null) {
      // The manager was not created: nobody else disposes the backend.
      const backend = engine.backend;
      await settle(() => backend.dispose(), CLEANUP_STEP_TIMEOUT_MS, log, 'backend');
    }
    for (const step of steps)
      await settle(step.run, step.timeoutMs ?? CLEANUP_STEP_TIMEOUT_MS, log, step.name);
  };

  /** Cleans up and rejects; main.ts logs the error and exits with `exitCode`. */
  const fail = async (exitCode: number, message: string, cause: unknown): Promise<never> => {
    if (shutdown?.stopping === true) {
      // CR-10: a shutdown (error shutdown of the crash handler, a signal) runs the same cleanup
      // already – wait for it instead of closing everything twice.
      await shutdown.stop('error', SERVER_EXIT_CODES.failure);
    } else {
      await cleanupAfterFailure();
    }
    throw new StartupError(exitCode, message, { cause });
  };

  try {
    engine = await createEngine(config, instance, options.fakeSpeed ?? DEFAULT_FAKE_SPEED);
    const { backend, claude } = engine;
    const manifest = await readSdkManifest();
    // Native Windows toasts (WP22-03/-15, A.9): off under tests/E2E (config.toasts).
    const toasts = createNativeToasts({
      enabled: config.toasts === 'native',
      language: () => stores.settings.get().language,
      log: log.child({ module: 'toasts' }),
      onUnavailable: () => {
        manager?.publishHostState();
      },
    });
    const sessions = createSessionManager({
      toasts,
      // WP22-06: the FakeBackend has no real process tree (fake PIDs) – no heartbeat snapshots.
      ...(config.backend === 'fake' ? { options: { processSnapshotMs: 0 } } : {}),
      backend,
      claude,
      stores: {
        registry: stores.registry,
        transcripts: stores.transcripts,
        decisions: stores.decisions,
        blobs: stores.blobs,
        settings: stores.settings,
        warnings: stores.warnings,
        processes: stores.processes,
      },
      host: {
        serverVersion: instance.serverVersion,
        sdkVersion: manifest?.sdkVersion ?? 'unknown',
        sdkClaudeCodeVersion: manifest?.claudeCodeVersion ?? 'unknown',
        platform: process.platform,
        dataDirLabel: config.dataDirLabel,
        dev: config.dev,
      },
      // The engine acks `server.shutdown` first and calls this via setImmediate (WP-13b).
      onShutdownRequested: () => {
        void shutdown?.stop('command');
      },
    });
    manager = sessions;
    // Invalid outgoing values are logged, counted and dropped – also in production, where real SDK
    // data reaches the contract for the first time (R3-05); tests and E2E: throw.
    const hub = createSyncHub({ source: sessions, instance, validation: config.validation });
    sessions.attachPublisher(hub); // before start() (WP-13 §3.5, R1-18)
    stores.warnings.onChange(() => {
      sessions.publishHostState();
    });
    await sessions.start();

    let webRoot = options.webRoot;
    if (webRoot !== null && !existsSync(webRoot)) {
      log.warn({ webRoot }, 'web UI not found - run "pnpm build" (API only)');
    } else if (webRoot !== null) {
      // A later build of dist/ must not change what this server serves (V2-03, ADR-066).
      webRoot = await prepareWebRoot({ source: webRoot, home: config.home, buildId: instance.buildId, log });
    }
    app = await createApp({
      config,
      instance,
      auth: stores.auth,
      blobs: stores.blobs,
      hub,
      webRoot,
    });
  } catch (error) {
    return fail(
      SERVER_EXIT_CODES.failure,
      `The Parallax server could not be set up: ${errorText(error)}`,
      error,
    );
  }

  // 5. Shutdown frame before listen: a signal or `server.shutdown` always finds it.
  const logging = options.logging ?? null;
  const sessions = manager;
  shutdown = createServerShutdown({
    stopSessions: () => sessions.shutdown(),
    // CR-02 (ADR-090): the sweep of the server's child trees only after the engine's C.8 window.
    graceMs: SHUTDOWN_SWEEP_GRACE_MS,
    steps,
    exit: (code) => {
      if (logging === null) {
        exit(code);
        return;
      }
      void settle(() => logging.close(), LOG_CLOSE_TIMEOUT_MS, log, 'logging').finally(() => {
        exit(code);
      });
    },
    logger: log,
  });
  if (options.signals !== null) uninstallSignals = shutdown.installSignalHandlers(options.signals);
  options.onShutdownFrame?.(shutdown);

  const listening = app;
  try {
    await listening.listen({ host: config.host, port: config.port });
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EADDRINUSE') {
      // The launcher also looks for "EADDRINUSE" in the output (race after its port probe).
      return fail(
        SERVER_EXIT_CODES.portInUse,
        `Port ${String(config.port)} on ${config.host} is already in use (EADDRINUSE).`,
        error,
      );
    }
    return fail(
      SERVER_EXIT_CODES.failure,
      `The Parallax server could not listen on ${config.host}:${String(config.port)} (${code ?? errorText(error)}).`,
      error,
    );
  }
  const address = listening.server.address();
  if (address === null || typeof address !== 'object') {
    return fail(SERVER_EXIT_CODES.failure, 'The Parallax server has no TCP address after listen.', address);
  }
  const port = address.port;

  // 6. Lock file: from now on the launcher regards the server as ready.
  try {
    lock = await writeServerLock({
      home: config.home,
      port,
      instance,
      launcherToken: stores.auth.launcherToken,
    });
  } catch (error) {
    return fail(
      SERVER_EXIT_CODES.failure,
      `The lock file in ${config.home} could not be written: ${errorText(error)}`,
      error,
    );
  }
  // A shutdown that started while the lock file was being written skipped its lock step.
  if (shutdown.stopping) await lock.release();

  // Access rights of the home in the background (≈ 2 s PowerShell, never throws; R2-13: warn only).
  const homeAccess = options.homeAccess === undefined ? logHomeAccess : options.homeAccess;
  if (homeAccess !== null) {
    accessCheck = homeAccess(config.home).catch((error: unknown) => {
      log.warn({ err: error }, 'home access check failed');
    });
  }

  // "Profil testen" of the default profile in the background (real claude only with --backend=sdk).
  const { claude } = engine;
  const defaultProfile = claude.profiles.getDefault().id;
  void claude
    .checkProfile(defaultProfile)
    .then(() => {
      sessions.publishHostState();
    })
    .catch((error: unknown) => {
      log.warn({ err: error, profileId: defaultProfile }, 'profile check failed');
    });

  const origin = serverOrigin(port);
  log.info(
    {
      url: origin,
      port,
      pid: process.pid,
      backend: config.backend,
      dev: config.dev,
      validation: config.validation,
      toasts: config.toasts,
      home: config.home,
      buildId: instance.buildId,
      serverInstanceId: instance.serverInstanceId,
    },
    'server listening',
  );

  return {
    config,
    instance,
    port,
    origin,
    app: listening,
    auth: stores.auth,
    manager: sessions,
    backend: engine.backend,
    lock,
    shutdown,
  };
}
