/**
 * The update service (WP-87 §2.1, ports.ts `UpdateService`): `HostState.app` / `HostState.update`,
 * the `update.*` host commands, "Install from file", "What's new" and the notices.
 *
 * - **State in memory** (E5): one operation at a time (check, prepare, upload, apply). While the
 *   status is checking, downloading, preparing or restarting – or an apply waits for its handshake
 *   – every command but `update.dismiss` answers UPDATE_BUSY {status}. Without an installation
 *   (checkout, dev) the status is `unsupported` and every command answers UPDATE_NOT_PACKAGED.
 * - **On disk** only `update-state.json` (dismissed version, stateFile.ts) and the marker of the
 *   last switch (marker.ts, consumed once when the service is created: `justUpdated` /
 *   `failedUpdate`).
 * - **Schedule:** the first automatic check 60 s after `start()`, then every 12 h (unref'd timers),
 *   only with an installation and `updates.check`; switched on again, it checks soon. An automatic
 *   check never runs during an operation or on a prepared (`ready`) update; its failure lands only
 *   in `error`.
 * - **Notifications:** status changes at once, progress at most twice a second (`onChange`).
 * - **Apply / rollback:** checked here (status, version as shown, `acceptDataLoss`, the version
 *   folder's signed release.json), then the orchestrator of this version takes over (apply.ts);
 *   after its READY the status is `restarting` and `requestRestart` runs on the next macrotask.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ChangelogQuery, ChangelogResponse, NoticeFile, NoticesResponse } from '@shared/http';
import {
  DEFAULT_UPDATE_STATE,
  type AppInfo,
  type Settings,
  type UpdateRelease,
  type UpdateState,
  type UpdateStatus,
} from '@shared/model';
import type { HostCommand, HostCommandName } from '@shared/protocol';
import { compareVersions } from '@shared/version';
import { readSignedRelease, type SdkRequest } from '../install/install';
import { DOWNLOADS_DIR, assertNotRealUserFolder, versionDir } from '../install/layout';
import { provideSdk } from '../install/sdk';
import { folderStamp } from '../install/versions';
import { settleWithin } from '../lib/async';
import { acquireDirectoryLock } from '../lib/homeLock';
import { logger as rootLogger } from '../lib/logger';
import { killProcessTree, runFile, type RunFileFn } from '../lib/process';
import type { ReleaseInfo } from '../launcher/release';
import { CommandError } from '../sync/ports';
import { handOver, spawnOrchestrator, type SpawnOrchestrator } from './apply';
import { availableNotes, installedNotes, readChangelogFile } from './changelog';
import { updateEndpoints, type UpdateEndpoints } from './endpoints';
import { orchestratorCommand } from './handoff';
import { checkFailedPayload, checkLatest, type LatestInfo } from './latest';
import { consumeUpdateResult } from './marker';
import { readNotice } from './notices';
import { UPDATE_COMMAND_NAMES, type UpdateService, type UpdateServiceOptions } from './ports';
import {
  UPLOAD_PREFIX,
  prepareErrorPayload,
  preparePackage,
  prepareRelease,
  type PrepareEnv,
  type PreparePhase,
  type PrepareRun,
  type RootLock,
} from './prepare';
import { findPrevious } from './previous';
import { readDismissedVersion, writeDismissedVersion } from './stateFile';

export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 12 * 60 * 60_000;
/** After `updates.check` is switched on again. */
export const RECHECK_SOON_MS = 10_000;
export const PROGRESS_THROTTLE_MS = 500;
/** `close()` waits at most this long for an aborted preparation (the SDK step is not abortable). */
export const CLOSE_WAIT_MS = 10_000;

/** Test seams; every default is the real thing. */
export interface UpdateServiceSeams {
  fetch?: typeof fetch;
  endpoints?: UpdateEndpoints;
  /** tar.exe (zip.ts). */
  run?: RunFileFn;
  provideSdk?: (request: SdkRequest) => Promise<string>;
  lockRoot?: (root: string) => Promise<RootLock | null>;
  spawn?: SpawnOrchestrator;
  kill?: (pid: number) => Promise<void>;
  now?: () => Date;
  nodeVersion?: string;
  nodeExe?: string;
  /** PID the orchestrator waits for (default `process.pid`). */
  pid?: number;
  handshakeMs?: number;
}

const BUSY_STATUSES: ReadonlySet<UpdateStatus> = new Set([
  'checking',
  'downloading',
  'preparing',
  'restarting',
]);

type OperationKind = 'check' | 'prepare' | 'upload' | 'apply';

interface Operation {
  kind: OperationKind;
  controller: AbortController;
  /** Settles when the work is over (never rejects). */
  done: Promise<void>;
}

interface Installation {
  root: string;
  own: ReleaseInfo;
}

async function defaultLockRoot(root: string): Promise<RootLock | null> {
  const result = await acquireDirectoryLock('install', root);
  if (result.kind === 'busy') return null;
  const lock = result.lock;
  return { release: () => lock.release() };
}

function fail(error: ErrorPayload): never {
  throw new CommandError(error);
}

/**
 * Creates the service; reads the marker of the last switch (deleted afterwards), the dismissed
 * version and the previous version first – only with an installation.
 */
export async function createUpdateService(
  options: UpdateServiceOptions,
  seams: UpdateServiceSeams = {},
): Promise<UpdateService> {
  const log = (options.logger ?? rootLogger).child({ module: 'update' });
  const now = seams.now ?? (() => new Date());
  const endpoints = seams.endpoints ?? updateEndpoints();
  const fetchFn = seams.fetch ?? globalThis.fetch;
  const nodeVersion = seams.nodeVersion ?? process.versions.node;
  const install: Installation | null =
    options.installRoot !== null && options.release !== null
      ? { root: options.installRoot, own: options.release }
      : null;
  const app: AppInfo = {
    version: install?.own.version ?? options.instance.serverVersion,
    buildId: options.instance.buildId,
    packaged: install !== null,
  };

  let state: UpdateState = { ...DEFAULT_UPDATE_STATE };
  if (install !== null) {
    assertNotRealUserFolder(install.root); // a test run never works on the real installation
    const consumed = await consumeUpdateResult(options.home, {
      version: install.own.version,
      buildId: install.own.buildId,
    });
    state = {
      ...state,
      status: 'idle',
      justUpdated: consumed.justUpdated,
      failedUpdate: consumed.failedUpdate,
      dismissedVersion: await readDismissedVersion(options.home),
      previous: await findPrevious(install.root, options.home, install.own),
    };
  }

  const listeners = new Set<() => void>();
  let progressTimer: NodeJS.Timeout | null = null;
  let checkTimer: NodeJS.Timeout | null = null;
  let checkEnabled = options.settings().updates.check;
  let started = false;
  let closed = false;
  let running: Operation | null = null;
  let orchestrator: number | null = null;
  /** latest.json and the signed CHANGELOG.md of a `github` offer. */
  let latest: LatestInfo | null = null;
  let changelogText: string | null = null;

  // ---- state and notifications ----

  function emit(): void {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    if (closed) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'update state listener failed');
      }
    }
  }

  function set(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function setProgress(fraction: number): void {
    const progress = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000;
    if (progress === state.progress) return;
    state = { ...state, progress };
    if (progressTimer !== null || closed) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      emit();
    }, PROGRESS_THROTTLE_MS);
    progressTimer.unref();
  }

  function onPhase(phase: PreparePhase, fraction: number): void {
    if (state.status !== phase) set({ status: phase, progress: Math.min(1, Math.max(0, fraction)) });
    else setProgress(fraction);
  }

  // ---- guards ----

  function needInstallation(): Installation {
    if (install === null) fail(makeError('UPDATE_NOT_PACKAGED'));
    return install;
  }

  function busyIssue(): ErrorPayload | null {
    if (running !== null) {
      return makeError('UPDATE_BUSY', { status: running.kind === 'apply' ? 'restarting' : state.status });
    }
    // Shutting down: the server goes away (or restarts) – the UI knows `restarting`.
    if (closed) return makeError('UPDATE_BUSY', { status: 'restarting' });
    if (BUSY_STATUSES.has(state.status)) return makeError('UPDATE_BUSY', { status: state.status });
    return null;
  }

  /** Installation present and nothing running; else throws. */
  function guard(): Installation {
    const found = needInstallation();
    const busy = busyIssue();
    if (busy !== null) fail(busy);
    return found;
  }

  /** Runs `work` as THE operation; `running` is cleared when it settles. */
  function exclusive<T>(kind: OperationKind, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const operation: Operation = { kind, controller, done: Promise.resolve() };
    running = operation;
    const promise = work(controller.signal).finally(() => {
      if (running === operation) running = null;
    });
    operation.done = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  /** An operation that goes on after the command's ack; `work` handles its own failures. */
  function background(kind: OperationKind, work: (signal: AbortSignal) => Promise<void>): void {
    exclusive(kind, work).catch((error: unknown) => {
      log.error({ err: error, kind }, 'update step failed unexpectedly');
    });
  }

  function prepareEnv(found: Installation): PrepareEnv {
    return {
      root: found.root,
      home: options.home,
      keys: endpoints.releaseKeys,
      registry: endpoints.registry,
      fetch: fetchFn,
      allowLoopbackHttp: endpoints.allowLoopbackHttp,
      run: seams.run ?? runFile,
      provideSdk:
        seams.provideSdk ??
        (async (request) =>
          (
            await provideSdk({
              ...request,
              log: (line) => {
                log.info({ step: 'sdk' }, line);
              },
            })
          ).source),
      lockRoot: seams.lockRoot ?? defaultLockRoot,
      nodeVersion,
      now,
      log,
      own: found.own,
    };
  }

  async function refreshPrevious(found: Installation): Promise<UpdateState['previous']> {
    return findPrevious(found.root, options.home, found.own);
  }

  // ---- check ----

  async function runCheck(found: Installation, manual: boolean, signal: AbortSignal): Promise<string | null> {
    const before = { status: state.status, available: state.available };
    set({ status: 'checking', progress: null });
    try {
      const result = await checkLatest({
        fetch: fetchFn,
        allowLoopbackHttp: endpoints.allowLoopbackHttp,
        signal,
        endpoints,
        running: found.own.version,
        log: (message) => {
          log.info(message);
        },
      });
      if (signal.aborted) {
        state = { ...state, status: before.status };
        return null;
      }
      const checkedAt = now().toISOString();
      if (result.kind === 'none') {
        if (before.status === 'ready') {
          set({ status: 'ready', checkedAt, error: null });
        } else {
          latest = null;
          changelogText = null;
          set({ status: 'idle', available: null, checkedAt, error: null });
        }
        return null;
      }
      const offered: UpdateRelease = {
        version: result.latest.version,
        source: 'github',
        size: result.latest.size,
        createdAt: result.latest.createdAt,
        downgrade: false,
        needsRestore: false,
        backupAt: null,
      };
      const prepared = before.status === 'ready' ? before.available : null;
      if (prepared !== null && !(manual && (compareVersions(offered.version, prepared.version) ?? 0) > 0)) {
        set({ status: 'ready', checkedAt, error: null });
        return offered.version;
      }
      latest = result.latest;
      changelogText = result.changelog;
      set({ status: 'available', available: offered, checkedAt, error: null });
      return offered.version;
    } catch (error) {
      if (signal.aborted) {
        state = { ...state, status: before.status };
        return null;
      }
      const payload = error instanceof CommandError ? error.error : checkFailedPayload(error);
      log.warn({ error: payload, manual }, 'update check failed');
      set({ status: before.status, error: payload });
      throw new CommandError(payload);
    }
  }

  function scheduleCheck(delayMs: number): void {
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = null;
    if (install === null || !started || closed || !checkEnabled) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void automaticCheck(install);
    }, delayMs);
    checkTimer.unref();
  }

  async function automaticCheck(found: Installation): Promise<void> {
    try {
      if (busyIssue() === null && state.status !== 'ready') {
        await exclusive('check', (signal) => runCheck(found, false, signal)).catch(() => undefined);
      }
    } finally {
      scheduleCheck(CHECK_INTERVAL_MS);
    }
  }

  // ---- prepare / upload ----

  function startPrepare(found: Installation, release: LatestInfo): void {
    background('prepare', async (signal) => {
      set({ status: 'downloading', progress: 0, error: null });
      const run: PrepareRun = { signal, onProgress: onPhase };
      try {
        await prepareRelease(prepareEnv(found), release, run);
        signal.throwIfAborted();
        const previous = await refreshPrevious(found);
        set({ status: 'ready', progress: null, error: null, previous });
      } catch (error) {
        if (signal.aborted) {
          state = { ...state, status: 'available', progress: null };
          return;
        }
        const payload = prepareErrorPayload(error, nodeVersion);
        log.warn({ err: error, error: payload }, 'update preparation failed');
        set({ status: 'available', progress: null, error: payload });
      }
    });
  }

  function startUpload(found: Installation, file: string): void {
    const before = { status: state.status, available: state.available, latest, changelogText };
    background('upload', async (signal) => {
      set({ status: 'preparing', progress: 0, error: null });
      const run: PrepareRun = { signal, onProgress: onPhase };
      const restore = (): void => {
        latest = before.latest;
        changelogText = before.changelogText;
      };
      try {
        const result = await preparePackage(prepareEnv(found), file, run);
        signal.throwIfAborted();
        latest = null;
        changelogText = null;
        const available: UpdateRelease = {
          version: result.release.version,
          source: 'file',
          size: null,
          createdAt: result.release.createdAt,
          downgrade: result.downgrade,
          needsRestore: result.needsRestore,
          backupAt: result.backupAt,
        };
        const previous = await refreshPrevious(found);
        set({ status: 'ready', progress: null, available, error: null, previous });
      } catch (error) {
        restore();
        if (signal.aborted) {
          state = { ...state, status: before.status, available: before.available, progress: null };
          return;
        }
        const payload = prepareErrorPayload(error, nodeVersion);
        log.warn({ err: error, error: payload }, 'update package refused');
        set({ status: before.status, available: before.available, progress: null, error: payload });
      }
    });
  }

  // ---- apply / rollback ----

  async function switchTo(found: Installation, version: string, restore: boolean): Promise<object> {
    try {
      const { release } = await readSignedRelease(versionDir(found.root, version), endpoints.releaseKeys);
      if (release.version !== version) throw new Error(`release.json names ${release.version}`);
    } catch (error) {
      const payload = makeError('UPDATE_RESTART_FAILED', { version, reason: 'package' });
      log.warn({ err: error, version }, 'the version to switch to is not intact');
      set({ error: payload });
      fail(payload);
    }
    const command = orchestratorCommand(
      {
        version,
        restore,
        waitPid: seams.pid ?? process.pid,
        installRoot: found.root,
        serverArgs: options.serverArgs,
      },
      options.repoRoot,
      seams.nodeExe ?? process.execPath,
    );
    log.info({ version, restore }, 'handing over to the update orchestrator');
    const result = await handOver(command, {
      spawn: seams.spawn ?? spawnOrchestrator,
      kill: seams.kill ?? killProcessTree,
      log,
      ...(seams.handshakeMs === undefined ? {} : { timeoutMs: seams.handshakeMs }),
    });
    if (result.kind === 'failed') {
      const payload = makeError('UPDATE_RESTART_FAILED', { version, reason: result.reason });
      set({ error: payload });
      fail(payload);
    }
    orchestrator = result.pid;
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = null;
    set({ status: 'restarting', progress: null, error: null });
    setImmediate(() => {
      options.requestRestart();
    });
    return {};
  }

  async function apply(version: string, acceptDataLoss: boolean): Promise<object> {
    const found = guard();
    const available = state.available;
    if (state.status !== 'ready' || available?.version !== version) {
      fail(makeError('VALIDATION_FAILED', { reason: 'version' }));
    }
    if (available.needsRestore && !acceptDataLoss) {
      fail(makeError('VALIDATION_FAILED', { reason: 'data_loss_not_accepted' }));
    }
    return exclusive('apply', () => switchTo(found, version, available.needsRestore));
  }

  function rollback(version: string, acceptDataLoss: boolean): Promise<object> {
    const found = guard();
    return exclusive('apply', async () => {
      const previous = await refreshPrevious(found);
      if (JSON.stringify(previous) !== JSON.stringify(state.previous)) set({ previous });
      if (previous?.version !== version) fail(makeError('VALIDATION_FAILED', { reason: 'version' }));
      if (previous.needsRestore) {
        if (previous.backupAt === null) fail(makeError('UPDATE_DOWNGRADE_BLOCKED', { version }));
        if (!acceptDataLoss) fail(makeError('VALIDATION_FAILED', { reason: 'data_loss_not_accepted' }));
      }
      return switchTo(found, version, previous.needsRestore);
    });
  }

  async function dismiss(what: 'available' | 'justUpdated' | 'failedUpdate' | 'error'): Promise<object> {
    needInstallation();
    switch (what) {
      case 'available': {
        const version = state.available?.version ?? null;
        if (version === null || version === state.dismissedVersion) return {};
        try {
          await writeDismissedVersion(options.home, version);
        } catch (error) {
          log.warn({ err: error }, 'update-state.json could not be written');
        }
        set({ dismissedVersion: version });
        return {};
      }
      case 'justUpdated':
        set({ justUpdated: null });
        return {};
      case 'failedUpdate':
        set({ failedUpdate: null });
        return {};
      case 'error':
        set({ error: null });
        return {};
    }
  }

  // ---- the port ----

  const names: readonly HostCommandName[] = UPDATE_COMMAND_NAMES;

  const service: UpdateService = {
    names,

    async handle(cmd: HostCommand): Promise<unknown> {
      switch (cmd.name) {
        case 'update.check': {
          const found = guard();
          const available = await exclusive('check', (signal) => runCheck(found, true, signal));
          return { available };
        }
        case 'update.prepare': {
          const found = guard();
          const offered = state.available;
          if (
            state.status !== 'available' ||
            offered?.version !== cmd.version ||
            offered.source !== 'github' ||
            latest?.version !== cmd.version
          ) {
            fail(makeError('VALIDATION_FAILED', { reason: 'version' }));
          }
          startPrepare(found, latest);
          return {};
        }
        case 'update.apply':
          return apply(cmd.version, cmd.acceptDataLoss);
        case 'update.rollback':
          return rollback(cmd.version, cmd.acceptDataLoss);
        case 'update.dismiss':
          return dismiss(cmd.what);
        default:
          return fail(makeError('NOT_IMPLEMENTED'));
      }
    },

    app: () => app,
    state: () => state,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (started || install === null) return;
      started = true;
      scheduleCheck(FIRST_CHECK_DELAY_MS);
    },

    settingsChanged(next: Settings) {
      const enabled = next.updates.check;
      if (enabled === checkEnabled) return;
      checkEnabled = enabled;
      scheduleCheck(RECHECK_SOON_MS);
    },

    uploadIssue() {
      if (install === null) return makeError('UPDATE_NOT_PACKAGED');
      return busyIssue();
    },

    uploadFile() {
      const found = needInstallation();
      const name = `${UPLOAD_PREFIX}${folderStamp(now())}-${randomUUID().slice(0, 8)}.zip`;
      return path.join(found.root, DOWNLOADS_DIR, name);
    },

    acceptPackage(file: string) {
      const issue = install === null ? makeError('UPDATE_NOT_PACKAGED') : busyIssue();
      if (install === null || issue !== null) {
        void rm(file, { force: true }).catch(() => undefined);
        log.warn({ error: issue }, 'uploaded update package refused');
        if (install !== null && issue !== null) set({ error: issue });
        return;
      }
      startUpload(install, file);
    },

    async changelog(query: ChangelogQuery): Promise<ChangelogResponse> {
      if (query.for === 'installed') {
        const text = await readChangelogFile(options.repoRoot);
        return { version: app.version, sections: installedNotes(text, app.version, query.since) };
      }
      const offered = state.available;
      if (install === null || offered === null) fail(makeError('FILE_NOT_FOUND'));
      if (offered.source === 'github') {
        return {
          version: offered.version,
          sections: availableNotes({
            running: app.version,
            target: offered.version,
            downgrade: false,
            text: latest?.version === offered.version ? changelogText : null,
            fallback: latest?.version === offered.version ? latest.notes : null,
          }),
        };
      }
      const text = await readChangelogFile(versionDir(install.root, offered.version));
      return {
        version: offered.version,
        sections: availableNotes({
          running: app.version,
          target: offered.version,
          downgrade: offered.downgrade,
          text,
          fallback: null,
        }),
      };
    },

    notice(file: NoticeFile): Promise<NoticesResponse> {
      return readNotice(options.repoRoot, file);
    },

    orchestratorPid: () => orchestrator,

    async close() {
      if (closed) return;
      closed = true;
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
      if (progressTimer !== null) clearTimeout(progressTimer);
      progressTimer = null;
      const operation = running;
      if (operation !== null && operation.kind !== 'apply') {
        operation.controller.abort();
        const settled = await settleWithin(() => operation.done, CLOSE_WAIT_MS);
        if (settled.outcome === 'timeout')
          log.warn({ kind: operation.kind }, 'update step still running at shutdown');
      }
      listeners.clear();
    },
  };
  return service;
}
