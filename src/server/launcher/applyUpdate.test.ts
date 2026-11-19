import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerLockFile } from '@shared/http';
import { sampleServerLockFile } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { restoreCurrent, switchVersion } from '../install/install';
import {
  InstallError,
  currentFileSchema,
  readCurrent,
  versionDir,
  type CurrentFile,
} from '../install/layout';
import { TEST_SDK, makeTestKey, makeTestPackage, testBuildId } from '../install/testPackage';
import type { DirectoryLockKind } from '../lib/homeLock';
import type { ToastRequest } from '../lib/toast';
import {
  createBackup,
  findBackup,
  pruneBackups,
  readLastBuildId,
  restoreBackup,
  writeLastBuildId,
  type BackupInfo,
} from '../store/backup';
import { APPLY_FAILED_PREFIX, APPLY_READY_LINE, APPLY_TIMEOUTS } from '../update/handoff';
import {
  UPDATE_RESULT_FILE,
  updateResultSchema,
  writeUpdateResult,
  type UpdateResult,
} from '../update/marker';
import {
  PRE_HANDSHAKE_BUDGET_MS,
  UPDATE_LOGS_KEPT,
  failureNotification,
  openUpdateLog,
  restartFailedReason,
  runApplyUpdate,
  type ApplyUpdateDeps,
  type ApplyUpdateRequest,
  type VersionToStart,
} from './applyUpdate';
import { LauncherError, type LauncherErrorReason, type LauncherOptions } from './launcher';
import type { ReleaseInfo } from './release';

const ROOT = 'D:\\px-apply\\root';
const HOME = 'D:\\px-apply\\home';
const OWN_DIR = `${ROOT}\\versions\\1.0.0`;
const LOG = `${HOME}\\logs\\update-20261117-120000.log`;
const SERVER_PID = 4242;
const LOCK_STARTED = '2026-11-17T08:00:00.000Z';
const BEFORE_LOCK = new Date('2026-11-17T07:59:59.000Z');
const AFTER_LOCK = new Date('2026-11-17T08:30:00.000Z');

function release(version: string): ReleaseInfo {
  return {
    schemaVersion: 1,
    name: 'parallax',
    version,
    commit: 'a'.repeat(40),
    buildId: testBuildId(version),
    minNode: '26.9.0',
    createdAt: '2026-11-17T09:00:00.000Z',
    schemas: { 'settings.json': 'b'.repeat(64) },
    sdk: TEST_SDK,
    files: {},
  };
}

const OWN = release('1.0.0');
const TARGET = release('1.0.1');
const INITIAL_CURRENT: CurrentFile = { schemaVersion: 1, version: '1.0.0', previous: '0.9.0' };

const request = (p: Partial<ApplyUpdateRequest> = {}): ApplyUpdateRequest => ({
  version: TARGET.version,
  restore: false,
  waitPid: SERVER_PID,
  installRoot: ROOT,
  home: HOME,
  port: 4711,
  serverArgs: [`--home=${HOME}`, '--port=4711', '--backend=sdk', `--install-root=${ROOT}`],
  backend: 'sdk',
  readyTimeoutMs: 60_000,
  toasts: 'native',
  ...p,
});

/** What `startVersion` does on one call: become ready, fail (with a server in some state) or find one. */
type StartBehaviour =
  'ready' | { fail: LauncherErrorReason; server: 'none' | 'running' | 'exited' } | { existing: string };

type OldServer =
  | { endsAfterMs: number }
  /** Never ends by itself; `startedAt` for processStartTime (null = unknown). */
  | { hangs: true; startedAt: Date | null }
  /** Ends (home lock free) after `ms`, but another process gets its PID at once. */
  | { pidReusedAfterMs: number; startedAt: Date };

interface WorldOptions {
  own?: ReleaseInfo | null;
  busy?: DirectoryLockKind[];
  serverLock?: Partial<ServerLockFile> | null;
  readRelease?: () => ReleaseInfo;
  checkNode?: () => void;
  sdk?: boolean;
  backupFound?: boolean;
  oldServer?: OldServer;
  verify?: () => ReleaseInfo;
  createBackupFails?: boolean;
  switchFails?: boolean;
  starts?: StartBehaviour[];
  /** Runs when a server of the target version is spawned (it "migrates" the data). */
  onTargetStart?: () => Promise<void>;
  delivered?: boolean;
  language?: 'en' | 'de';
  overrides?: Partial<ApplyUpdateDeps>;
}

interface World {
  deps: ApplyUpdateDeps;
  stdout: string[];
  /** Side effects in order (home lock tries are left out). */
  calls: string[];
  markers: UpdateResult[];
  starts: { target: VersionToStart; options: LauncherOptions }[];
  toasts: ToastRequest[];
  log: string[];
  state: { data: string; current: string; lastBuildId: string | null; held: Set<string> };
  now(): number;
}

function world(w: WorldOptions = {}): World {
  let now = 0;
  let handshakeAt: number | null = null;
  let killedOld = false;
  let nextPid = 9001;
  let backups = 0;
  let newServer: { pid: number; alive: boolean } | null = null;
  const savedData = new Map<string, string>([[`${HOME}\\backups\\found`, 'data while 1.0.1 ran']]);
  const queue = [...(w.starts ?? [])];
  const old = w.oldServer ?? { endsAfterMs: 2_000 };
  const out: Omit<World, 'deps' | 'now'> = {
    stdout: [],
    calls: [],
    markers: [],
    starts: [],
    toasts: [],
    log: [],
    state: {
      data: 'original',
      current: JSON.stringify(INITIAL_CURRENT),
      lastBuildId: OWN.buildId,
      held: new Set(),
    },
  };
  const sinceHandshake = () => (handshakeAt === null ? -1 : now - handshakeAt);
  const oldHoldsHome = () => {
    if (killedOld) return false;
    if ('endsAfterMs' in old) return handshakeAt === null || sinceHandshake() < old.endsAfterMs;
    if ('hangs' in old) return true;
    return handshakeAt === null || sinceHandshake() < old.pidReusedAfterMs;
  };
  const oldAlive = () => {
    if (killedOld) return false;
    if ('pidReusedAfterMs' in old) return true;
    return oldHoldsHome();
  };
  const spawn = (onStarted: (server: { pid: number; exited: Promise<unknown> }) => void) => {
    let resolveExit: (value: unknown) => void = () => undefined;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const server = { pid: nextPid++, alive: true };
    newServer = server;
    onStarted({ pid: server.pid, exited });
    return {
      server,
      exit: () => {
        resolveExit({ code: 1, signal: null });
      },
    };
  };

  const deps: ApplyUpdateDeps = {
    own: { release: w.own === undefined ? OWN : w.own, dir: OWN_DIR },
    tryLock: (kind) => {
      if (kind === 'home') {
        const busy = oldHoldsHome() || newServer?.alive === true;
        return Promise.resolve(
          busy ? { kind: 'busy' } : { kind: 'acquired', release: () => Promise.resolve() },
        );
      }
      if (w.busy?.includes(kind) === true) return Promise.resolve({ kind: 'busy' });
      out.calls.push(`lock ${kind}`);
      out.state.held.add(kind);
      return Promise.resolve({
        kind: 'acquired',
        release: () => {
          out.calls.push(`release ${kind}`);
          out.state.held.delete(kind);
          return Promise.resolve();
        },
      });
    },
    readServerLock: () =>
      Promise.resolve(
        w.serverLock === null
          ? { kind: 'missing' }
          : {
              kind: 'ok',
              lock: sampleServerLockFile({
                pid: SERVER_PID,
                buildId: OWN.buildId,
                startedAt: LOCK_STARTED,
                ...w.serverLock,
              }),
            },
      ),
    readRelease: () => Promise.resolve().then(() => (w.readRelease ?? (() => TARGET))()),
    checkNode: () => {
      w.checkNode?.();
    },
    sdkPresent: () => Promise.resolve(w.sdk ?? true),
    findBackup: (_home, change) => {
      out.calls.push(`find backup ${String(change.from)} -> ${change.to}`);
      const found: BackupInfo = {
        dir: `${HOME}\\backups\\found`,
        name: 'found',
        manifest: {
          schemaVersion: 1,
          from: change.from,
          to: change.to,
          createdAt: '2026-11-10T08:00:00.000Z',
          files: [],
          transcripts: {},
        },
      };
      return Promise.resolve(w.backupFound === false ? null : found);
    },
    isAlive: (pid) => (pid === SERVER_PID ? oldAlive() : newServer?.pid === pid && newServer.alive),
    processStartTime: (pid) => {
      if (pid !== SERVER_PID) return Promise.resolve(null);
      return Promise.resolve('endsAfterMs' in old ? BEFORE_LOCK : old.startedAt);
    },
    killOldServer: (pid) => {
      out.calls.push(`kill old ${String(pid)}`);
      killedOld = true;
      return Promise.resolve();
    },
    killTree: (pid) => {
      out.calls.push(`kill tree ${String(pid)}`);
      if (newServer?.pid === pid) newServer.alive = false;
      return Promise.resolve();
    },
    verifyVersion: () => {
      out.calls.push('verify');
      return Promise.resolve().then(() => (w.verify ?? (() => TARGET))());
    },
    readLastBuildId: () => Promise.resolve(out.state.lastBuildId),
    createBackup: (_home, change) => {
      out.calls.push(`backup ${String(change.from)} -> ${change.to}`);
      if (w.createBackupFails === true) return Promise.reject(new Error('disk full'));
      const dir = `${HOME}\\backups\\b${String(++backups)}`;
      savedData.set(dir, out.state.data);
      return Promise.resolve(dir);
    },
    restoreBackup: (_home, dir) => {
      out.calls.push(`restore ${dir}`);
      const saved = savedData.get(dir);
      if (saved === undefined) return Promise.reject(new Error(`no backup ${dir}`));
      out.state.data = saved;
      return Promise.resolve();
    },
    writeLastBuildId: (_home, buildId) => {
      out.calls.push(`last ${buildId}`);
      out.state.lastBuildId = buildId;
      return Promise.resolve();
    },
    pruneBackups: () => {
      out.calls.push('prune');
      return Promise.resolve();
    },
    readCurrent: () => Promise.resolve(currentFileSchema.parse(JSON.parse(out.state.current))),
    switchVersion: (_root, version, previous) => {
      out.calls.push(`switch ${version} (previous ${previous})`);
      if (w.switchFails === true) return Promise.reject(new InstallError('current.json is locked'));
      out.state.current = JSON.stringify({ schemaVersion: 1, version, previous });
      return Promise.resolve();
    },
    restoreCurrent: (_root, before) => {
      out.calls.push(`restore current ${before.version}`);
      out.state.current = JSON.stringify(before);
      return Promise.resolve();
    },
    cleanupVersions: (_root, keep) => {
      out.calls.push(`cleanup ${keep.join(',')}`);
      return Promise.resolve({ removed: ['0.9.0'], problems: [] });
    },
    writeMarker: (_home, result) => {
      out.calls.push(`marker ${result.outcome}`);
      out.markers.push(updateResultSchema.parse(result));
      return Promise.resolve();
    },
    startVersion: async (target, options, onStarted) => {
      out.calls.push(`start ${target.version}`);
      out.starts.push({ target, options });
      const behaviour = queue.shift() ?? 'ready';
      const ok = (pid: number) => ({
        result: {
          mode: 'started' as const,
          port: options.port,
          pid,
          url: null,
          chromePid: null,
          window: false,
        },
        buildId: target.release.buildId,
      });
      if (typeof behaviour === 'object' && 'existing' in behaviour) {
        return {
          result: {
            mode: 'existing',
            port: options.port,
            pid: 777,
            url: null,
            chromePid: null,
            window: false,
          },
          buildId: behaviour.existing,
        };
      }
      if (typeof behaviour === 'object' && behaviour.server === 'none') {
        throw new LauncherError(behaviour.fail, `no start (${behaviour.fail})`);
      }
      const spawned = spawn(onStarted);
      if (target.version === TARGET.version) {
        out.state.data = 'migrated by 1.0.1';
        await w.onTargetStart?.();
      }
      if (behaviour === 'ready') return ok(spawned.server.pid);
      if (behaviour.server === 'exited') {
        spawned.server.alive = false;
        spawned.exit();
        await Promise.resolve();
      }
      throw new LauncherError(behaviour.fail, `the server failed (${behaviour.fail})`);
    },
    notify: (toast) => {
      out.calls.push('notify');
      out.toasts.push(toast);
      return Promise.resolve({ kind: 'shown' });
    },
    language: () => w.language ?? 'en',
    handshake: (line) => {
      out.stdout.push(line);
      if (line === APPLY_READY_LINE) handshakeAt = now;
      return Promise.resolve(w.delivered ?? true);
    },
    log: (line) => {
      out.log.push(line);
    },
    logPath: LOG,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
    ...w.overrides,
  };
  return { ...out, deps, now: () => now };
}

const START_CALLS = ['lock launch', 'lock install'];
const RELEASE_CALLS = ['release install', 'release launch'];

describe('runApplyUpdate – the orchestrator of a version switch (WP-87 §2.2)', () => {
  it('switches: checks, handshake, backup, marker pending, current.json, start without a window, cleanup', async () => {
    const w = world();
    expect(await runApplyUpdate(request(), w.deps)).toBe(0);
    expect(w.stdout).toEqual([APPLY_READY_LINE]);
    expect(w.calls).toEqual([
      ...START_CALLS,
      'verify',
      `backup ${OWN.buildId} -> ${TARGET.buildId}`,
      `last ${TARGET.buildId}`,
      'prune',
      'marker pending',
      'switch 1.0.1 (previous 1.0.0)',
      'start 1.0.1',
      'cleanup 1.0.1,1.0.0',
      ...RELEASE_CALLS,
    ]);
    expect(w.markers[0]).toMatchObject({
      outcome: 'pending',
      from: { version: '1.0.0', buildId: OWN.buildId },
      to: { version: '1.0.1', buildId: TARGET.buildId },
      backupDir: `${HOME}\\backups\\b1`,
      error: null,
      log: LOG,
    });
    expect(w.starts[0]?.target).toEqual({
      version: '1.0.1',
      release: TARGET,
      dir: versionDir(ROOT, '1.0.1'),
    });
    expect(w.starts[0]?.options).toEqual({
      home: HOME,
      port: 4711,
      serverArgs: request().serverArgs,
      build: true,
      printUrl: false,
      openWindow: false,
      installRoot: ROOT,
      backend: 'sdk',
      readyTimeoutMs: 60_000,
    });
    expect(w.state.current).toBe(JSON.stringify({ schemaVersion: 1, version: '1.0.1', previous: '1.0.0' }));
    expect(w.state.held.size).toBe(0);
    expect(w.toasts).toEqual([]);
    expect(w.log.join('\n')).toMatch(/Done: Parallax 1\.0\.1 runs/);
  });

  it('takes last-version.json as the "from" of the backup when there is one', async () => {
    const w = world();
    w.state.lastBuildId = '0.9.0+older';
    await runApplyUpdate(request(), w.deps);
    expect(w.calls).toContain(`backup 0.9.0+older -> ${TARGET.buildId}`);
  });

  const refusals: [string, WorldOptions, string][] = [
    ['no release.json (checkout)', { own: null }, 'package'],
    ['the start lock is held', { busy: ['launch'] }, 'lock'],
    ['the install lock is held', { busy: ['install'] }, 'lock'],
    ['no lock file', { serverLock: null }, 'lock'],
    ['the lock file names another PID', { serverLock: { pid: 99 } }, 'lock'],
    ['the lock file names another build', { serverLock: { buildId: '0.9.0+x' } }, 'lock'],
    [
      'the target is not signed',
      {
        readRelease: () => {
          throw new InstallError('invalid signature', { reason: 'signature' });
        },
      },
      'package',
    ],
    ['release.json names another version', { readRelease: () => release('1.0.2') }, 'package'],
    [
      'Node.js is too old',
      {
        checkNode: () => {
          throw new InstallError('needs Node.js 26', { reason: 'node' });
        },
      },
      'package',
    ],
    ['the Agent SDK is missing', { sdk: false }, 'package'],
  ];

  it.each(refusals)(
    'refuses before the handshake when %s – the server keeps running',
    async (_n, options, reason) => {
      const w = world(options);
      expect(await runApplyUpdate(request(), w.deps)).toBe(1);
      expect(w.stdout).toEqual([`${APPLY_FAILED_PREFIX} ${reason}`]);
      expect(w.calls.filter((call) => !call.startsWith('lock ') && !call.startsWith('release '))).toEqual([]);
      expect(w.state.held.size).toBe(0);
      expect(w.markers).toEqual([]);
      // Within the server's handshake wait, also when a lock never frees.
      expect(w.now()).toBeLessThanOrEqual(PRE_HANDSHAKE_BUDGET_MS + 1_000);
    },
  );

  it('restore mode needs the backup of the target version', async () => {
    const w = world({ backupFound: false });
    expect(await runApplyUpdate(request({ restore: true }), w.deps)).toBe(1);
    expect(w.stdout).toEqual([`${APPLY_FAILED_PREFIX} backup`]);
    expect(w.calls).toContain(`find backup ${TARGET.buildId} -> ${OWN.buildId}`);
  });

  it('restore mode: backup first, then the backup of the target version is restored', async () => {
    const w = world();
    expect(await runApplyUpdate(request({ restore: true }), w.deps)).toBe(0);
    const backup = w.calls.indexOf(`backup ${OWN.buildId} -> ${TARGET.buildId}`);
    expect(w.calls.slice(backup, backup + 3)).toEqual([
      `backup ${OWN.buildId} -> ${TARGET.buildId}`,
      `restore ${HOME}\\backups\\found`,
      `last ${TARGET.buildId}`,
    ]);
  });

  it('nothing happens when the handshake cannot be delivered', async () => {
    const w = world({ delivered: false });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls).toEqual([...START_CALLS, ...RELEASE_CALLS]);
  });

  it('the old server does not end: its tree is ended after serverExitMs (it started before the lock file)', async () => {
    const w = world({ oldServer: { hangs: true, startedAt: BEFORE_LOCK } });
    expect(await runApplyUpdate(request(), w.deps)).toBe(0);
    expect(w.calls).toContain(`kill old ${String(SERVER_PID)}`);
    expect(w.now()).toBeGreaterThanOrEqual(APPLY_TIMEOUTS.serverExitMs);
  });

  it('a reused PID is never ended: the free home lock decides', async () => {
    const w = world({ oldServer: { pidReusedAfterMs: 1_000, startedAt: AFTER_LOCK } });
    expect(await runApplyUpdate(request(), w.deps)).toBe(0);
    expect(w.calls.some((call) => call.startsWith('kill old'))).toBe(false);
    expect(w.calls).toContain('start 1.0.1');
  });

  it.each([
    ['started after the lock file', AFTER_LOCK],
    ['with an unknown start time', null],
  ])(
    'a hanging PID %s is not ended; the home stays locked → marker failed (lock), nothing switched',
    async (_n, startedAt) => {
      const w = world({ oldServer: { hangs: true, startedAt } });
      expect(await runApplyUpdate(request(), w.deps)).toBe(1);
      expect(w.calls.some((call) => call.startsWith('kill old'))).toBe(false);
      expect(w.calls).toEqual([...START_CALLS, 'marker failed', 'notify', ...RELEASE_CALLS]);
      expect(w.markers[0]?.error).toEqual({
        code: 'UPDATE_RESTART_FAILED',
        params: { version: '1.0.1', reason: 'lock' },
      });
      expect(w.toasts[0]?.body).toContain(LOG);
    },
  );

  it('the full check fails: no switch, marker failed (package), the own version starts again', async () => {
    const w = world({
      verify: () => {
        throw new InstallError('dist/server.js does not match release.json', { reason: 'files' });
      },
    });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls).toEqual([
      ...START_CALLS,
      'verify',
      'marker failed',
      `last ${OWN.buildId}`,
      'start 1.0.0',
      ...RELEASE_CALLS,
    ]);
    expect(w.markers[0]).toMatchObject({
      outcome: 'failed',
      backupDir: null,
      from: { buildId: OWN.buildId },
    });
    expect(w.markers[0]?.error?.params).toEqual({ version: '1.0.1', reason: 'package' });
    expect(w.starts[1]).toBeUndefined();
    expect(w.starts[0]?.target).toEqual({ version: '1.0.0', release: OWN, dir: OWN_DIR });
    expect(w.state.current).toBe(JSON.stringify(INITIAL_CURRENT));
  });

  it('a failed backup: no switch, marker failed (backup), the own version starts again', async () => {
    const w = world({ createBackupFails: true });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls).not.toContain('marker pending');
    expect(w.calls.some((call) => call.startsWith('switch'))).toBe(false);
    expect(w.markers.at(-1)?.error?.params).toEqual({ version: '1.0.1', reason: 'backup' });
    expect(w.calls).toContain('start 1.0.0');
  });

  it('a failed switch of current.json goes back to the old current.json', async () => {
    const w = world({ switchFails: true });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls).toContain('restore current 1.0.0');
    expect(w.state.current).toBe(JSON.stringify(INITIAL_CURRENT));
    expect(w.markers.at(-1)?.error?.params).toEqual({ version: '1.0.1', reason: 'package' });
  });

  it.each([
    ['server_timeout', 'running', 'timeout'],
    ['server_exited', 'exited', 'exited'],
    ['store_too_new', 'exited', 'store_too_new'],
  ] as const)(
    '%s of the new version → way back (%s server): data, current.json, marker, own start',
    async (fail, server, reason) => {
      const w = world({ starts: [{ fail, server }] });
      expect(await runApplyUpdate(request(), w.deps)).toBe(1);
      const killed = server === 'running' ? ['kill tree 9001'] : [];
      expect(w.calls).toEqual([
        ...START_CALLS,
        'verify',
        `backup ${OWN.buildId} -> ${TARGET.buildId}`,
        `last ${TARGET.buildId}`,
        'prune',
        'marker pending',
        'switch 1.0.1 (previous 1.0.0)',
        'start 1.0.1',
        ...killed,
        'marker failed',
        `restore ${HOME}\\backups\\b1`,
        `last ${OWN.buildId}`,
        'restore current 1.0.0',
        'start 1.0.0',
        ...RELEASE_CALLS,
      ]);
      expect(w.state.data).toBe('original');
      expect(w.state.current).toBe(JSON.stringify(INITIAL_CURRENT));
      expect(w.state.lastBuildId).toBe(OWN.buildId);
      expect(w.markers.at(-1)).toMatchObject({
        outcome: 'failed',
        backupDir: `${HOME}\\backups\\b1`,
        error: { code: 'UPDATE_RESTART_FAILED', params: { version: '1.0.1', reason } },
        log: LOG,
      });
      expect(w.toasts).toEqual([]);
    },
  );

  it('another server of a foreign build answers instead of the new version → way back (port)', async () => {
    const w = world({ starts: [{ existing: '0.8.0+foreign' }] });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.markers.at(-1)?.error?.params).toEqual({ version: '1.0.1', reason: 'port' });
    // The foreign server holds no home lock in this world: the data comes back, the own start follows.
    expect(w.calls).toContain('start 1.0.0');
  });

  it('the way back fails too: notification (German after settings.json) with the log path, exit 1', async () => {
    const w = world({
      starts: [
        { fail: 'server_exited', server: 'exited' },
        { fail: 'server_timeout', server: 'none' },
      ],
      language: 'de',
    });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls.slice(-3)).toEqual(['notify', ...RELEASE_CALLS]);
    expect(w.toasts).toEqual([failureNotification('de', '1.0.1', LOG)]);
    expect(w.toasts[0]?.title).toBe('Parallax-Update fehlgeschlagen');
    expect(w.markers.at(-1)?.outcome).toBe('failed');
    expect(w.state.held.size).toBe(0);
  });

  it('the new server cannot be ended: the data is not touched, notification', async () => {
    const w = world({
      starts: [{ fail: 'server_timeout', server: 'running' }],
      overrides: { killTree: () => Promise.reject(new Error('access denied')) },
    });
    expect(await runApplyUpdate(request(), w.deps)).toBe(1);
    expect(w.calls.some((call) => call.startsWith('restore '))).toBe(false);
    expect(w.calls.slice(-4)).toEqual(['marker failed', 'notify', ...RELEASE_CALLS]);
    expect(w.state.data).toBe('migrated by 1.0.1');
  });

  it('--toasts=off: no notification, the log says why', async () => {
    const w = world({
      starts: [
        { fail: 'server_exited', server: 'exited' },
        { fail: 'server_exited', server: 'none' },
      ],
    });
    expect(await runApplyUpdate(request({ toasts: 'off' }), w.deps)).toBe(1);
    expect(w.toasts).toEqual([]);
    expect(w.log.join('\n')).toMatch(/Notifications are off/);
  });

  it('maps launcher failures to UPDATE_RESTART_FAILED reasons', () => {
    const cases: [LauncherErrorReason, string][] = [
      ['server_timeout', 'timeout'],
      ['server_exited', 'exited'],
      ['store_too_new', 'store_too_new'],
      ['port_in_use', 'port'],
      ['port_denied', 'port'],
      ['package_damaged', 'package'],
      ['server_start_failed', 'spawn'],
    ];
    for (const [launcher, reason] of cases) {
      expect(restartFailedReason(new LauncherError(launcher, 'x'))).toBe(reason);
    }
    expect(restartFailedReason(new Error('boom'))).toBe('spawn');
  });
});

describe('runApplyUpdate with the real backup and switch functions (temp folders)', () => {
  const temps: string[] = [];
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('timeout of the new version: current.json and the root files byte for byte, the data back', async () => {
    const base = await makeTempHome('wp87b-apply-');
    temps.push(base);
    const root = path.join(base, 'root');
    const home = path.join(base, 'home');
    const key = makeTestKey();
    await makeTestPackage(versionDir(root, '1.0.0'), { version: '1.0.0', key, rootFiles: true });
    await makeTestPackage(versionDir(root, '1.0.1'), {
      version: '1.0.1',
      key,
      rootFiles: true,
      files: { 'root/start.mjs': '// start.mjs of 1.0.1\n' },
    });
    const quiet = () => undefined;
    await switchVersion(root, '1.0.0', { previous: '0.9.0', log: quiet });
    await mkdir(path.join(home, 'entries', 'en_one'), { recursive: true });
    await writeFile(path.join(home, 'settings.json'), '{"schemaVersion":1,"theme":"dark"}\n');
    await writeFile(path.join(home, 'entries', 'en_one', 'decisions.json'), '{"schemaVersion":1}\n');
    await writeLastBuildId(home, OWN.buildId);
    const snapshot = async () => ({
      current: await readFile(path.join(root, 'current.json')),
      start: await readFile(path.join(root, 'start.mjs')),
      cmd: await readFile(path.join(root, 'parallax.cmd')),
      settings: await readFile(path.join(home, 'settings.json'), 'utf8'),
    });
    const before = await snapshot();

    const w = world({
      starts: [{ fail: 'server_timeout', server: 'running' }],
      onTargetStart: async () => {
        expect(await readFile(path.join(root, 'start.mjs'), 'utf8')).toBe('// start.mjs of 1.0.1\n');
        await writeFile(path.join(home, 'settings.json'), '{"schemaVersion":2}\n');
        await mkdir(path.join(home, 'entries', 'en_two'), { recursive: true });
        await writeFile(path.join(home, 'entries', 'en_two', 'decisions.json'), '{"schemaVersion":2}\n');
      },
      overrides: {
        own: { release: OWN, dir: versionDir(root, '1.0.0') },
        readCurrent: (dir) => readCurrent(dir),
        switchVersion: async (dir, version, previous) => {
          await switchVersion(dir, version, { previous, log: quiet });
        },
        restoreCurrent: (dir, file) => restoreCurrent(dir, file),
        readLastBuildId: (dir) => readLastBuildId(dir),
        writeLastBuildId: (dir, buildId) => writeLastBuildId(dir, buildId),
        createBackup: async (dir, change) => (await createBackup(dir, change)).dir,
        restoreBackup: async (dir, backup) => {
          await restoreBackup(dir, backup);
        },
        pruneBackups: async (dir) => {
          await pruneBackups(dir);
        },
        findBackup: (dir, change) => findBackup(dir, change),
        writeMarker: (dir, result) => writeUpdateResult(dir, result),
      },
    });
    expect(await runApplyUpdate(request({ installRoot: root, home }), w.deps)).toBe(1);

    const after = await snapshot();
    expect(after.current.equals(before.current)).toBe(true);
    expect(after.start.equals(before.start)).toBe(true);
    expect(after.cmd.equals(before.cmd)).toBe(true);
    expect(after.settings).toBe(before.settings);
    await expect(readFile(path.join(home, 'entries', 'en_two', 'decisions.json'))).rejects.toThrow();
    expect(await readLastBuildId(home)).toBe(OWN.buildId);
    const marker = updateResultSchema.parse(
      JSON.parse(await readFile(path.join(home, UPDATE_RESULT_FILE), 'utf8')),
    );
    expect(marker).toMatchObject({ outcome: 'failed', error: { params: { reason: 'timeout' } } });
    expect(marker.backupDir).not.toBeNull();
    // The data of the failed version is kept below the backup (`newer\`).
    expect(await readdir(path.join(marker.backupDir ?? '', 'newer', 'entries'))).toEqual(['en_two']);
  });
});

describe('update log and notification texts', () => {
  const temps: string[] = [];
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('writes logs\\update-<time>.log and keeps the five newest', async () => {
    const home = await makeTempHome('wp87b-log-');
    temps.push(home);
    const logs = path.join(home, 'logs');
    await mkdir(logs, { recursive: true });
    for (let day = 10; day < 16; day++)
      await writeFile(path.join(logs, `update-202611${String(day)}-080000.log`), 'old');
    await writeFile(path.join(logs, 'server.out.log'), 'kept');
    const log = openUpdateLog(home, new Date(2026, 10, 17, 9, 30, 5));
    expect(log.path).toBe(path.join(logs, 'update-20261117-093005.log'));
    log.write('first step');
    expect(await readFile(log.path ?? '', 'utf8')).toMatch(/^\S+Z first step\n$/u);
    const names = (await readdir(logs)).filter((name) => name.startsWith('update-')).sort();
    expect(names).toHaveLength(UPDATE_LOGS_KEPT);
    expect(names[0]).toBe('update-20261112-080000.log');
    expect(await readdir(logs)).toContain('server.out.log');
  });

  it('the notification names the version and the log, in English or German', () => {
    const en = failureNotification('en', '1.0.1', LOG);
    expect(en.title).toBe('Parallax update failed');
    expect(en.body).toContain('1.0.1');
    expect(en.body).toContain(LOG);
    expect(en.body.length).toBeLessThanOrEqual(300);
    expect(failureNotification('de', '1.0.1', null).body).toMatch(/Startmenü/);
  });
});
