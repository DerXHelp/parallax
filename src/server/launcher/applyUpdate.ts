/**
 * The orchestrator of a version switch (WP-87 §2.2, E1–E3; docs/wp/WP-83.md §9.3/§9.4). It runs as
 * `versions\<old>\dist\launcher.js --install-root=<root> --apply-update=<v> --wait-pid=<pid>
 * [--restore] <server flags>`, started by the server of the OLD version (update/handoff.ts): the
 * code of the old version always orchestrates, so the flags, the handshake and the formats
 * (`current.json`, `release.json`, `update-result.json`) change only additively.
 *
 *  1. Locks `launch` (data directory) and `install` (root): no launcher, autostart, notification
 *     click or install.cmd starts anything during the switch.
 *  2. Checks before the handshake: the lock file names `waitPid` and the own build, the target's
 *     release.json is signed, Node is new enough, the SDK is there, in restore mode the backup
 *     exists. Else `PARALLAX-APPLY-FAILED <reason>`, nothing changed – the server keeps running.
 *  3. `PARALLAX-APPLY-READY`: the server shuts down like "Stop server".
 *  4. Waits until the home lock is free and `waitPid` ended; after `serverExitMs` it ends the old
 *     server – only when that process started before the lock file's `startedAt` (a reused PID is
 *     never ended). Still locked: marker `failed (lock)`, notification, nothing switched.
 *  5. Full check of `versions\<v>` (signature, every hash, SDK).
 *  6. Backup of the stores (restore mode: then the backup of the target version is restored, the
 *     data since then stays in the new backup), `last-version.json`, old backups pruned.
 *  7. Marker `pending`, then current.json and the root files switch to `<v>`.
 *  8. The new version starts without a window – `launchLocked`, the launcher's own start logic
 *     (E2: a new launcher would wait for the launch lock held here).
 *  9. Success: old version folders are cleaned up.
 * 10. Otherwise back: the new server tree ended, data, last-version.json and current.json restored,
 *     marker `failed`, the own version started again.
 * 11. If that fails too: a Windows notification with the log path.
 *
 * Every step goes to `<home>\logs\update-<time>.log` (the five newest stay). stdout carries only
 * the handshake line – the server closes that pipe right after it. Every side effect is a
 * dependency (`ApplyUpdateDeps`, unit-tested with fakes); the real ones come from
 * `createNodeApplyUpdateDeps`, real processes only in E2E (WP-89).
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Language } from '@shared/common';
import { makeError, type UpdateRestartFailedReason } from '@shared/errors';
import type { BackendKind, ServerLockFile } from '@shared/http';
import { PRODUCT_NAME } from '@shared/product';
import { readSettingsFile, type ServerConfig } from '../config';
import { readCurrent, versionDir, type CurrentFile } from '../install/layout';
import {
  checkNodeVersion,
  readSignedRelease,
  restoreCurrent,
  switchVersion,
  verifyVersion,
} from '../install/install';
import { cleanupVersions, folderStamp, type CleanupResult } from '../install/versions';
import { sleep, toError } from '../lib/async';
import type { DirectoryLockKind } from '../lib/homeLock';
import { childProcesses, errnoCode, isProcessAlive, killProcessTree, processStartTime } from '../lib/process';
import { showToast, type ToastRequest, type ToastResult } from '../lib/toast';
import {
  createBackup,
  findBackup,
  pruneBackups,
  readLastBuildId,
  restoreBackup,
  writeLastBuildId,
  type BackupInfo,
} from '../store/backup';
import { updateEndpoints } from '../update/endpoints';
import { APPLY_READY_LINE, APPLY_TIMEOUTS, handshakeLine } from '../update/handoff';
import { UPDATE_RESULT_SCHEMA_VERSION, writeUpdateResult, type UpdateResult } from '../update/marker';
import type { ApplyUpdateArgs } from './args';
import { SERVER_BUNDLE, pollLock } from './build';
import {
  LauncherError,
  createNodeLauncherDeps,
  launchLocked,
  tryDirectoryLock,
  type LauncherDeps,
  type LauncherOptions,
  type LauncherResult,
  type LockAttempt,
} from './launcher';
import { readServerLock, type LockReadResult } from './lockFile';
import { AGENT_SDK_PACKAGE, type ReleaseInfo } from './release';
import { logsDir } from './serverProcess';

/** What cli.ts hands over: the flags of the hand-over plus the resolved server configuration. */
export interface ApplyUpdateRequest extends ApplyUpdateArgs {
  installRoot: string;
  home: string;
  port: number;
  /** For the new version (and the way back): `serverArgsFor(config)` + `--install-root`. */
  serverArgs: readonly string[];
  backend: BackendKind;
  /** The new version must be healthy within this time (`readyTimeoutMs(env)`, default 60 s). */
  readyTimeoutMs: number;
  /** `--toasts` of the server: `off` = no Windows notification, the log only. */
  toasts: ServerConfig['toasts'];
  /** Notes of loadConfig – into the update log, never to stdout. */
  notes?: readonly string[];
}

/** A version folder to start with `launchLocked`. */
export interface VersionToStart {
  version: string;
  release: ReleaseInfo;
  /** `versions\<v>` (dist/, node_modules/). */
  dir: string;
}

/** A server process `startVersion` spawned (reported before it is ready). */
export interface StartedServerInfo {
  pid: number;
  /** Resolves when that process ended. */
  exited: Promise<unknown>;
}

export interface VersionStart {
  result: LauncherResult;
  /** Build id in the lock file of the server that answers (null = unknown). */
  buildId: string | null;
}

export interface ApplyUpdateDeps {
  /** The running launcher: its release.json (null = a checkout) and its folder (`versions\<own>`). */
  own: { release: ReleaseInfo | null; dir: string };
  /** One non-blocking try of the named-pipe lock `kind` of `dir`. */
  tryLock(kind: DirectoryLockKind, dir: string): Promise<LockAttempt>;
  readServerLock(home: string): Promise<LockReadResult>;
  /** release.json of `versions\<v>` with a valid signature (throws otherwise). */
  readRelease(root: string, version: string): Promise<ReleaseInfo>;
  /** Throws when this Node.js is older than `release.minNode`. */
  checkNode(release: ReleaseInfo): void;
  /** The Agent SDK's package.json exists in `versions\<v>` (the full check is `verifyVersion`). */
  sdkPresent(root: string, version: string): Promise<boolean>;
  findBackup(home: string, change: { from: string | null; to: string }): Promise<BackupInfo | null>;
  isAlive(pid: number): boolean;
  /** Creation time of `pid`; null = missing or unknown. */
  processStartTime(pid: number): Promise<Date | null>;
  /**
   * Ends the old server: its child process trees (never this process – the orchestrator is a child
   * of that server, `taskkill /T` on it would end the orchestrator too), then the process itself.
   * Children older than `startedAt` are skipped (reused parent PIDs).
   */
  killOldServer(pid: number, startedAt: Date): Promise<void>;
  /** `taskkill /PID <pid> /T /F` (the tree of a server this orchestrator started). */
  killTree(pid: number): Promise<void>;
  /** Signature, every hash and the SDK of `versions\<v>` (throws otherwise). */
  verifyVersion(root: string, version: string): Promise<ReleaseInfo>;
  readLastBuildId(home: string): Promise<string | null>;
  /** Saves the stores; resolves with the backup folder. */
  createBackup(home: string, change: { from: string | null; to: string }): Promise<string>;
  restoreBackup(home: string, dir: string): Promise<void>;
  writeLastBuildId(home: string, buildId: string): Promise<void>;
  pruneBackups(home: string): Promise<void>;
  /** current.json; null when it is missing or damaged. */
  readCurrent(root: string): Promise<CurrentFile | null>;
  /** Root files and current.json → `version` (`previous` as given). */
  switchVersion(root: string, version: string, previous: string): Promise<void>;
  /** current.json exactly as before, then the root files of that version. */
  restoreCurrent(root: string, before: CurrentFile): Promise<void>;
  cleanupVersions(root: string, keep: readonly string[]): Promise<CleanupResult>;
  writeMarker(home: string, result: UpdateResult): Promise<void>;
  /** `launchLocked` for `target` (no window, no backup step); throws `LauncherError` & co. */
  startVersion(
    target: VersionToStart,
    options: LauncherOptions,
    onStarted: (server: StartedServerInfo) => void,
  ): Promise<VersionStart>;
  notify(request: ToastRequest): Promise<ToastResult>;
  /** Language of the notification (settings.json, default English). */
  language(home: string): Language;
  /** Writes one line to stdout; false = it could not be delivered (the server no longer listens). */
  handshake(line: string): Promise<boolean>;
  /** One line of the update log. */
  log(line: string): void;
  /** Absolute path of the update log (marker, notification); null = none could be created. */
  readonly logPath: string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Poll interval while waiting for locks and the old server. */
export const APPLY_POLL_MS = 250;
/**
 * The server waits `handshakeMs` (20 s) for the handshake from the spawn on; everything before it
 * must end in time, or a late READY would reach a server that already gave up and keeps running.
 * So the lock waits before the handshake are capped at this budget (not `lockMs`).
 */
export const PRE_HANDSHAKE_BUDGET_MS = APPLY_TIMEOUTS.handshakeMs - 5_000;
export const UPDATE_LOG_PREFIX = 'update-';
export const UPDATE_LOGS_KEPT = 5;
const UPDATE_LOG_PATTERN = /^update-\d{8}-\d{6}\.log$/u;
const TOAST_TAG = 'parallax-update';

/** The two fixed notification texts of step 11 (German or English after settings.json). */
export function failureNotification(language: Language, version: string, log: string | null): ToastRequest {
  const where = log ?? '-';
  return language === 'de'
    ? {
        title: `${PRODUCT_NAME}-Update fehlgeschlagen`,
        body:
          `Der Wechsel auf ${PRODUCT_NAME} ${version} ist fehlgeschlagen, und ${PRODUCT_NAME} ließ sich nicht ` +
          `wieder starten. Starte es über das Startmenü. Protokoll: ${where}`,
        tag: TOAST_TAG,
      }
    : {
        title: `${PRODUCT_NAME} update failed`,
        body:
          `Switching to ${PRODUCT_NAME} ${version} failed, and ${PRODUCT_NAME} could not be started again. ` +
          `Start it from the Start menu. Log: ${where}`,
        tag: TOAST_TAG,
      };
}

/** `UPDATE_RESTART_FAILED.reason` of a failed start (docs/wp/WP-87.md §2.2 step 10). */
export function restartFailedReason(error: unknown): UpdateRestartFailedReason {
  if (!(error instanceof LauncherError)) return 'spawn';
  switch (error.reason) {
    case 'server_timeout':
      return 'timeout';
    case 'server_exited':
      return 'exited';
    case 'store_too_new':
      return 'store_too_new';
    case 'port_in_use':
    case 'port_denied':
    case 'backend_mismatch':
      return 'port';
    case 'package_damaged':
      return 'package';
    default:
      return 'spawn';
  }
}

function describe(error: unknown): string {
  return toError(error).message;
}

interface Context {
  request: ApplyUpdateRequest;
  deps: ApplyUpdateDeps;
  own: ReleaseInfo;
  target: ReleaseInfo;
  /** The lock file of the server that hands over (step 2). */
  serverLock: ServerLockFile;
  /** Restore mode: the backup made when the target version was left. */
  restoreFrom: BackupInfo | null;
}

/** What the way back has to undo. */
interface Undo {
  backupDir: string | null;
  /** switchVersion was called (maybe half done): current.json goes back. */
  switched: boolean;
  /** current.json before the switch (null: missing or damaged). */
  before: CurrentFile | null;
  /** The server of the new version, once spawned. */
  started: { pid: number; gone: boolean } | null;
}

type Checked =
  { kind: 'ok'; context: Context } | { kind: 'failed'; reason: UpdateRestartFailedReason; message: string };

/**
 * Runs steps 1–11 (file comment); resolves with the exit code: 0 = the new version runs, 1 = it
 * does not (refused before the handshake, back on the own version, or nothing runs). Never throws.
 */
export async function runApplyUpdate(request: ApplyUpdateRequest, deps: ApplyUpdateDeps): Promise<number> {
  const held: (() => Promise<void>)[] = [];
  let handedOver = false;
  try {
    deps.log(
      `Switching ${request.installRoot} to Parallax ${request.version}` +
        `${request.restore ? ' with the backup of that version' : ''} (data: ${request.home}, ` +
        `server PID ${String(request.waitPid)}, orchestrator ${deps.own.release?.version ?? 'checkout'}).`,
    );
    for (const note of request.notes ?? []) deps.log(`Note: ${note}`);
    const checked = await checkBeforeHandshake(request, deps, held);
    if (checked.kind === 'failed') {
      deps.log(`Refused before the hand-over (${checked.reason}): ${checked.message}`);
      await deps.handshake(handshakeLine({ kind: 'failed', reason: checked.reason }));
      return 1;
    }
    if (!(await deps.handshake(APPLY_READY_LINE))) {
      deps.log('The handshake could not be delivered (the server no longer listens) - nothing switched.');
      return 1;
    }
    handedOver = true;
    deps.log('Handshake sent - the server shuts down.');
    return await switchOver(checked.context);
  } catch (error) {
    // Each step handles its own failures; this is the last resort.
    deps.log(`Unexpected error: ${toError(error).stack ?? describe(error)}`);
    if (!handedOver) await deps.handshake(handshakeLine({ kind: 'failed', reason: 'spawn' }));
    else await notifyFailure(request, deps);
    return 1;
  } finally {
    for (const release of held.splice(0).reverse()) await release().catch(() => undefined);
    deps.log('Locks released.');
  }
}

async function takeLock(
  kind: DirectoryLockKind,
  dir: string,
  deadline: number,
  deps: ApplyUpdateDeps,
): Promise<(() => Promise<void>) | null> {
  const lock = await pollLock(() => deps.tryLock(kind, dir), {
    waitMs: Math.max(0, Math.min(APPLY_TIMEOUTS.lockMs, deadline - deps.now())),
    pollMs: APPLY_POLL_MS,
    sleep: (ms) => deps.sleep(ms),
    now: () => deps.now(),
    onWaiting: () => {
      deps.log(`The ${kind} lock of ${dir} is held by another process - waiting...`);
    },
  });
  return lock?.release ?? null;
}

/** Steps 1–2. Locks taken go to `held` (released by the caller). */
async function checkBeforeHandshake(
  request: ApplyUpdateRequest,
  deps: ApplyUpdateDeps,
  held: (() => Promise<void>)[],
): Promise<Checked> {
  const fail = (reason: UpdateRestartFailedReason, message: string): Checked => ({
    kind: 'failed',
    reason,
    message,
  });
  const deadline = deps.now() + PRE_HANDSHAKE_BUDGET_MS;
  const own = deps.own.release;
  if (own === null) {
    return fail('package', `${deps.own.dir} has no release.json - only an installation switches versions`);
  }
  if (own.version === request.version) return fail('package', `Parallax ${own.version} runs already`);

  try {
    const launch = await takeLock('launch', request.home, deadline, deps);
    if (launch === null) return fail('lock', `another launcher holds the start lock of ${request.home}`);
    held.push(launch);
    const install = await takeLock('install', request.installRoot, deadline, deps);
    if (install === null) {
      return fail('lock', `another installer or update holds the lock of ${request.installRoot}`);
    }
    held.push(install);
  } catch (error) {
    return fail('lock', `the locks could not be taken: ${describe(error)}`);
  }

  const read = await deps.readServerLock(request.home);
  if (read.kind !== 'ok') return fail('lock', `the lock file of ${request.home} is ${read.kind}`);
  if (read.lock.pid !== request.waitPid) {
    return fail(
      'lock',
      `the lock file names server PID ${String(read.lock.pid)}, not ${String(request.waitPid)}`,
    );
  }
  if (read.lock.buildId !== own.buildId) {
    return fail('lock', `the running server is build ${read.lock.buildId}, this orchestrator ${own.buildId}`);
  }

  let target: ReleaseInfo;
  try {
    target = await deps.readRelease(request.installRoot, request.version);
    if (target.version !== request.version) {
      return fail('package', `release.json of ${request.version} names version ${target.version}`);
    }
    deps.checkNode(target);
    if (!(await deps.sdkPresent(request.installRoot, request.version))) {
      return fail(
        'package',
        `the Agent SDK is missing in ${versionDir(request.installRoot, request.version)}`,
      );
    }
  } catch (error) {
    return fail('package', describe(error));
  }

  let restoreFrom: BackupInfo | null = null;
  if (request.restore) {
    try {
      restoreFrom = await deps.findBackup(request.home, { from: target.buildId, to: own.buildId });
    } catch (error) {
      return fail('backup', `the backups could not be read: ${describe(error)}`);
    }
    if (restoreFrom === null) {
      return fail('backup', `no backup of the change ${target.buildId} -> ${own.buildId} in ${request.home}`);
    }
    deps.log(`Restore mode: backup ${restoreFrom.dir} (${restoreFrom.manifest.createdAt}).`);
  }
  deps.log(`Checked: lock file, release.json of ${target.version} (build ${target.buildId}), Node, SDK.`);
  return { kind: 'ok', context: { request, deps, own, target, serverLock: read.lock, restoreFrom } };
}

/** One try of the home lock, released at once: true = no server holds the data directory. */
async function homeLockFree(ctx: Context): Promise<boolean> {
  try {
    const attempt = await ctx.deps.tryLock('home', ctx.request.home);
    if (attempt.kind === 'busy') return false;
    await attempt.release();
    return true;
  } catch (error) {
    ctx.deps.log(`The home lock could not be tried: ${describe(error)}`);
    return false;
  }
}

/** Polls until `done()` or `ms` passed; resolves with the last answer. */
async function waitUntil(ctx: Context, ms: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = ctx.deps.now() + ms;
  for (;;) {
    if (await done()) return true;
    if (ctx.deps.now() >= deadline) return false;
    await ctx.deps.sleep(APPLY_POLL_MS);
  }
}

/** Step 4: true = the home lock is free (the old server is gone or does not matter any more). */
async function waitForOldServer(ctx: Context): Promise<boolean> {
  const { deps, request } = ctx;
  const pid = request.waitPid;
  const ended = await waitUntil(
    ctx,
    APPLY_TIMEOUTS.serverExitMs,
    async () => (await homeLockFree(ctx)) && !deps.isAlive(pid),
  );
  if (ended) {
    deps.log(`The old server (PID ${String(pid)}) ended and released ${request.home}.`);
    return true;
  }
  let killed = false;
  if (deps.isAlive(pid)) {
    const started = await deps.processStartTime(pid);
    const lockStart = Date.parse(ctx.serverLock.startedAt);
    if (started !== null && started.getTime() < lockStart) {
      deps.log(`The old server (PID ${String(pid)}) did not end in time - ending its process tree.`);
      try {
        await deps.killOldServer(pid, started);
        killed = true;
      } catch (error) {
        deps.log(`Ending PID ${String(pid)} failed: ${describe(error)}`);
      }
    } else {
      // A reused PID (or an unknown start time) is never ended.
      deps.log(
        `PID ${String(pid)} still exists, but ${started === null ? 'its start time is unknown' : 'it started after the server'}` +
          ' - not ended.',
      );
    }
  }
  const free = await waitUntil(
    ctx,
    APPLY_TIMEOUTS.killGraceMs,
    async () => (await homeLockFree(ctx)) && (!killed || !deps.isAlive(pid)),
  );
  if (free) return true;
  // Killed, but the process lingers: the lock alone decides whether the data is free.
  return homeLockFree(ctx);
}

function versionOf(target: ReleaseInfo, dir: string): VersionToStart {
  return { version: target.version, release: target, dir };
}

async function writeMarker(
  ctx: Context,
  part: Pick<UpdateResult, 'outcome' | 'backupDir' | 'error'>,
): Promise<void> {
  const { deps, own, target } = ctx;
  try {
    await deps.writeMarker(ctx.request.home, {
      schemaVersion: UPDATE_RESULT_SCHEMA_VERSION,
      ...part,
      from: { version: own.version, buildId: own.buildId },
      to: { version: target.version, buildId: target.buildId },
      at: new Date(deps.now()).toISOString(),
      log: deps.logPath,
    });
  } catch (error) {
    deps.log(`The marker (${part.outcome}) could not be written: ${describe(error)}`);
  }
}

function writeFailed(
  ctx: Context,
  reason: UpdateRestartFailedReason,
  backupDir: string | null,
): Promise<void> {
  return writeMarker(ctx, {
    outcome: 'failed',
    backupDir,
    error: makeError('UPDATE_RESTART_FAILED', { version: ctx.target.version, reason }),
  });
}

async function notifyFailure(request: ApplyUpdateRequest, deps: ApplyUpdateDeps): Promise<void> {
  if (request.toasts === 'off') {
    deps.log('Notifications are off (--toasts=off) - see this log.');
    return;
  }
  try {
    const shown = await deps.notify(
      failureNotification(deps.language(request.home), request.version, deps.logPath),
    );
    deps.log(shown.kind === 'failed' ? `The notification failed: ${shown.reason}` : 'Notification shown.');
  } catch (error) {
    deps.log(`The notification failed: ${describe(error)}`);
  }
}

/** Step 8 (and the start of the way back): null = healthy, else why not. */
async function startVersion(
  ctx: Context,
  target: VersionToStart,
  undo: Undo | null,
): Promise<UpdateRestartFailedReason | null> {
  const { deps, request } = ctx;
  const options: LauncherOptions = {
    home: request.home,
    port: request.port,
    serverArgs: request.serverArgs,
    build: true,
    printUrl: false,
    openWindow: false,
    installRoot: request.installRoot,
    backend: request.backend,
    readyTimeoutMs: request.readyTimeoutMs,
  };
  deps.log(
    `Starting Parallax ${target.version} (ready within ${String(Math.round(request.readyTimeoutMs / 1000))} s)...`,
  );
  try {
    const started = await deps.startVersion(target, options, (server) => {
      deps.log(`Server of ${target.version} started (PID ${String(server.pid)}).`);
      if (undo === null) return;
      const record = { pid: server.pid, gone: false };
      undo.started = record;
      void server.exited.then(() => {
        record.gone = true;
      });
    });
    const { result } = started;
    if (result.mode === 'existing' && started.buildId !== target.release.buildId) {
      deps.log(
        `Another Parallax server (build ${started.buildId ?? 'unknown'}, PID ${String(result.pid)}) answers ` +
          `for ${request.home} - not ${target.version}.`,
      );
      return 'port';
    }
    deps.log(
      `Parallax ${target.version} is ready on port ${String(result.port)} (PID ${String(result.pid)}` +
        `${result.mode === 'existing' ? ', already running' : ''}).`,
    );
    return null;
  } catch (error) {
    deps.log(`Parallax ${target.version} did not start: ${describe(error)}`);
    return restartFailedReason(error);
  }
}

/** Steps 4–9; failures lead to the way back (step 10). */
async function switchOver(ctx: Context): Promise<number> {
  const { deps, request, own, target } = ctx;
  const root = request.installRoot;
  const home = request.home;
  const undo: Undo = { backupDir: null, switched: false, before: null, started: null };

  if (!(await waitForOldServer(ctx))) {
    deps.log(`${home} is still locked by another process - nothing switched.`);
    await writeFailed(ctx, 'lock', null);
    await notifyFailure(request, deps);
    return 1;
  }

  try {
    const verified = await deps.verifyVersion(root, target.version);
    if (verified.buildId !== target.buildId) {
      throw new Error(`release.json changed since the check (build ${verified.buildId})`);
    }
    deps.log(`Full check of ${versionDir(root, target.version)} passed.`);
  } catch (error) {
    deps.log(`Full check of ${versionDir(root, target.version)} failed: ${describe(error)}`);
    return rollBack(ctx, undo, 'package');
  }

  try {
    const last = await deps.readLastBuildId(home);
    undo.backupDir = await deps.createBackup(home, { from: last ?? own.buildId, to: target.buildId });
    deps.log(`Backup of the data: ${undo.backupDir}`);
    if (ctx.restoreFrom !== null) {
      await deps.restoreBackup(home, ctx.restoreFrom.dir);
      deps.log(`Restored the backup ${ctx.restoreFrom.dir} (the data since then is in ${undo.backupDir}).`);
    }
    await deps.writeLastBuildId(home, target.buildId);
  } catch (error) {
    deps.log(`Backup step failed: ${describe(error)}`);
    return rollBack(ctx, undo, 'backup');
  }
  await deps.pruneBackups(home).catch((error: unknown) => {
    deps.log(`Old backups could not be pruned: ${describe(error)}`);
  });

  await writeMarker(ctx, { outcome: 'pending', backupDir: undo.backupDir, error: null });
  try {
    undo.before = await deps.readCurrent(root);
    undo.switched = true;
    await deps.switchVersion(root, target.version, own.version);
    deps.log(`current.json now names ${target.version} (previous ${own.version}).`);
  } catch (error) {
    deps.log(`Switching current.json failed: ${describe(error)}`);
    return rollBack(ctx, undo, 'package');
  }

  const failed = await startVersion(ctx, versionOf(target, versionDir(root, target.version)), undo);
  if (failed !== null) return rollBack(ctx, undo, failed);

  const cleanup = await deps.cleanupVersions(root, [target.version, own.version]);
  if (cleanup.removed.length > 0) deps.log(`Removed old versions: ${cleanup.removed.join(', ')}.`);
  for (const problem of cleanup.problems) deps.log(`Cleanup: ${problem}`);
  deps.log(`Done: Parallax ${target.version} runs.`);
  return 0;
}

/** Step 10 (and 11 when it fails). Always 1: the switch did not happen. */
async function rollBack(ctx: Context, undo: Undo, reason: UpdateRestartFailedReason): Promise<number> {
  const { deps, request, own } = ctx;
  const root = request.installRoot;
  const home = request.home;
  deps.log(`Going back to Parallax ${own.version} (reason: ${reason}).`);
  if (undo.started !== null && !undo.started.gone) {
    try {
      await deps.killTree(undo.started.pid);
      deps.log(`Ended the server of ${ctx.target.version} (PID ${String(undo.started.pid)}).`);
    } catch (error) {
      deps.log(`Ending PID ${String(undo.started.pid)} failed: ${describe(error)}`);
    }
  }
  const free = await waitUntil(ctx, APPLY_TIMEOUTS.killGraceMs, () => homeLockFree(ctx));
  // After the new server is gone: it would consume (delete) a marker written while it starts.
  await writeFailed(ctx, reason, undo.backupDir);
  if (!free) {
    deps.log(`${home} is still locked - the data was not restored.`);
    return failBack(ctx);
  }
  try {
    if (undo.backupDir !== null) {
      await deps.restoreBackup(home, undo.backupDir);
      deps.log(`Restored the data from ${undo.backupDir}.`);
    }
    await deps.writeLastBuildId(home, own.buildId);
    if (undo.switched) {
      // A missing/damaged current.json before: the own version is what ran – name it.
      await deps.restoreCurrent(
        root,
        undo.before ?? { schemaVersion: 1, version: own.version, previous: null },
      );
      deps.log(`current.json names ${own.version} again.`);
    }
  } catch (error) {
    deps.log(`Going back failed: ${describe(error)}`);
    return failBack(ctx);
  }
  if ((await startVersion(ctx, versionOf(own, deps.own.dir), null)) !== null) return failBack(ctx);
  deps.log(`Back on Parallax ${own.version}.`);
  return 1;
}

async function failBack(ctx: Context): Promise<number> {
  const { deps, request } = ctx;
  deps.log(
    `No Parallax server runs for ${request.home}. Start Parallax from the Start menu` +
      `${deps.logPath === null ? '' : `; this log: ${deps.logPath}`}.`,
  );
  await notifyFailure(request, deps);
  return 1;
}

// =====================================================================================
// The real dependencies
// =====================================================================================

export interface UpdateLog {
  /** Absolute path, or null when the file could not be created (lines are dropped then). */
  path: string | null;
  write: (line: string) => void;
}

/** Deletes the oldest `update-*.log` beyond `UPDATE_LOGS_KEPT` (names sort by time). Never throws. */
function pruneUpdateLogs(dir: string): void {
  try {
    const names = readdirSync(dir)
      .filter((name) => UPDATE_LOG_PATTERN.test(name))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - UPDATE_LOGS_KEPT))) {
      rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // a log folder that cannot be listed keeps its files
  }
}

/**
 * `<home>\logs\update-<YYYYMMDD-HHmmss>.log` (local time), appended line by line synchronously, so
 * a crash keeps everything up to it; the five newest logs stay. Never throws.
 */
export function openUpdateLog(home: string, now: Date = new Date()): UpdateLog {
  const dir = logsDir(home);
  let file: string | null = path.join(dir, `${UPDATE_LOG_PREFIX}${folderStamp(now)}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, '');
    pruneUpdateLogs(dir);
  } catch {
    file = null;
  }
  return {
    path: file,
    write: (line) => {
      if (file === null) return;
      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // logging never fails the switch
      }
    },
  };
}

export interface NodeApplyUpdateDepsOptions {
  own: ApplyUpdateDeps['own'];
  home: string;
  /** stdout of the orchestrator (main.ts): only the handshake line goes there. */
  handshake: (line: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Default `openUpdateLog(home)`. */
  log?: UpdateLog;
}

/** Upper bound of the CIM query for the start time / the children of the old server. */
const PROCESS_QUERY_MS = 30_000;

/** The real dependencies (file system, named pipes, processes, toasts, `launchLocked`). */
export function createNodeApplyUpdateDeps(options: NodeApplyUpdateDepsOptions): ApplyUpdateDeps {
  const env = options.env ?? process.env;
  const log = options.log ?? openUpdateLog(options.home);
  // Read when needed: a test build takes them from the environment and throws on a bad value.
  const keys = (): readonly string[] => updateEndpoints(env).releaseKeys;
  return {
    own: options.own,
    tryLock: (kind, dir) => tryDirectoryLock(kind, dir),
    readServerLock: (home) => readServerLock(home),
    readRelease: async (root, version) =>
      (await readSignedRelease(versionDir(root, version), keys())).release,
    checkNode: (release) => {
      checkNodeVersion(release);
    },
    sdkPresent: async (root, version) => {
      const file = path.join(
        versionDir(root, version),
        'node_modules',
        ...AGENT_SDK_PACKAGE.split('/'),
        'package.json',
      );
      try {
        return (await stat(file)).isFile();
      } catch {
        return false;
      }
    },
    findBackup: (home, change) => findBackup(home, change),
    isAlive: (pid) => isProcessAlive(pid),
    processStartTime: (pid) => processStartTime(pid, { timeoutMs: PROCESS_QUERY_MS }),
    killOldServer: async (pid, startedAt) => {
      const children = await childProcesses(pid, { timeoutMs: PROCESS_QUERY_MS });
      if (children.kind === 'ok') {
        for (const child of children.processes) {
          if (child.pid === process.pid || child.startedAt.getTime() < startedAt.getTime()) continue;
          try {
            await killProcessTree(child.pid);
            log.write(`Ended the process tree of ${child.name} (PID ${String(child.pid)}).`);
          } catch (error) {
            log.write(`Ending ${child.name} (PID ${String(child.pid)}) failed: ${describe(error)}`);
          }
        }
      } else {
        log.write(
          `The children of PID ${String(pid)} are unknown (${children.reason}) - only the server is ended.`,
        );
      }
      try {
        // TerminateProcess on Windows – the process alone, see ApplyUpdateDeps.killOldServer.
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (errnoCode(error) !== 'ESRCH') throw error;
      }
    },
    killTree: (pid) => killProcessTree(pid),
    verifyVersion: (root, version) => verifyVersion(root, version, keys()),
    readLastBuildId: (home) => readLastBuildId(home),
    createBackup: async (home, change) => (await createBackup(home, change)).dir,
    restoreBackup: async (home, dir) => {
      const restored = await restoreBackup(home, dir);
      for (const warning of restored.warnings) {
        log.write(
          `Restore: transcript ${warning.file} is ${warning.reason} (saved ${String(warning.savedBytes)} bytes).`,
        );
      }
    },
    writeLastBuildId: (home, buildId) => writeLastBuildId(home, buildId),
    pruneBackups: async (home) => {
      await pruneBackups(home);
    },
    readCurrent: (root) => readCurrent(root).catch(() => null),
    switchVersion: async (root, version, previous) => {
      await switchVersion(root, version, { previous, log: log.write });
    },
    restoreCurrent: (root, before) => restoreCurrent(root, before),
    cleanupVersions: (root, keep) => cleanupVersions(root, keep),
    writeMarker: (home, result) => writeUpdateResult(home, result),
    startVersion: async (target, launch, onStarted) => {
      const base = createNodeLauncherDeps({
        repoRoot: target.dir,
        release: target.release,
        workDir: launch.installRoot ?? null,
        home: launch.home,
        serverScript: path.join(target.dir, SERVER_BUNDLE),
        env,
        out: log.write,
      });
      const deps: LauncherDeps = {
        ...base,
        // The orchestrator made the backup and wrote last-version.json and the marker itself.
        backupBeforeStart: () => Promise.resolve({ kind: 'unchanged' }),
        startServer: async (args) => {
          const server = await base.startServer(args);
          onStarted({ pid: server.pid, exited: server.exited });
          return server;
        },
      };
      const result = await launchLocked(launch, deps);
      const lock = await base.readLock(launch.home);
      return {
        result,
        buildId: lock.kind === 'ok' && lock.lock.pid === result.pid ? lock.lock.buildId : null,
      };
    },
    notify: (request) => showToast(request),
    language: (home) => readSettingsFile(home).settings?.language ?? 'en',
    handshake: options.handshake,
    log: log.write,
    logPath: log.path,
    sleep,
    now: () => Date.now(),
  };
}
