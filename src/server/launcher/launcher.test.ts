import { describe, expect, it } from 'vitest';
import { takeAuthCodeFromHash, type ServerLockFile } from '@shared/http';
import {
  SAMPLE_IDS,
  sampleHealthResponse,
  sampleLauncherCode,
  sampleServerLockFile,
  sampleToken,
  sampleUuid,
} from '@shared/samples';
import type { HealthCheck, LauncherCodeResult, RunningServerCheck } from './client';
import { edgeAppArgs, edgeProfileDir } from './edgeWindow';
import {
  CODE_RETRY_DELAYS_MS,
  LauncherError,
  createNodeLauncherDeps,
  runLauncher,
  type LauncherDeps,
  type LauncherOptions,
} from './launcher';
import type { ServerExit, StartedServer } from './serverProcess';

const HOME = 'C:\\Users\\u\\AppData\\Local\\Temp\\parallax-test\\home';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SERVER_PID = 5150;

const options = (p: Partial<LauncherOptions> = {}): LauncherOptions => ({
  home: HOME,
  port: 4711,
  serverArgs: [`--home=${HOME}`, '--port=4711'],
  build: true,
  printUrl: false,
  readyTimeoutMs: 3_000,
  pollMs: 100,
  ...p,
});

const okHealth = (lock: ServerLockFile, p: Parameters<typeof sampleHealthResponse>[0] = {}): HealthCheck => ({
  kind: 'ok',
  health: sampleHealthResponse({ serverInstanceId: lock.serverInstanceId, ...p }),
});

/**
 * A scripted world: an optional running server (lock + health), what a newly started server does
 * (`onStart`), a fake clock driven by `sleep`, and a record of every side effect.
 */
interface World {
  deps: LauncherDeps;
  out: string[];
  edgeCalls: { edge: string; args: readonly string[] }[];
  /** allowNotifications calls (WP22-03). */
  grants: { home: string; origin: string }[];
  started: (readonly string[])[];
  builds: number;
  /** Lock + health of the server that answers (changed by `onStart`). */
  current: { lock: ServerLockFile | null; health: Map<number, HealthCheck> };
}

interface WorldOptions {
  running?: ServerLockFile;
  found?: RunningServerCheck;
  /** Behaviour of a started server: becomes ready after `readyAfterMs`, or exits. */
  onStart?: { readyAfterMs: number; port?: number } | { exit: ServerExit; output?: string } | { hang: true };
  overrides?: Partial<LauncherDeps>;
}

function world(w: WorldOptions = {}): World {
  let now = 0;
  const state: Omit<World, 'deps'> = {
    out: [],
    edgeCalls: [],
    grants: [],
    started: [],
    builds: 0,
    current: { lock: w.running ?? null, health: new Map() },
  };
  if (w.running !== undefined) state.current.health.set(w.running.port, okHealth(w.running));
  let readyAt = Number.POSITIVE_INFINITY;
  let pendingLock: ServerLockFile | null = null;
  let resolveExit: (exit: ServerExit) => void = () => undefined;
  let exitAt: { at: number; exit: ServerExit } | null = null;

  const tick = (ms: number) => {
    now += ms;
    if (pendingLock !== null && now >= readyAt) {
      state.current.lock = pendingLock;
      state.current.health.set(pendingLock.port, okHealth(pendingLock));
      pendingLock = null;
    }
    if (exitAt !== null && now >= exitAt.at) {
      resolveExit(exitAt.exit);
      exitAt = null;
    }
  };

  const deps: LauncherDeps = {
    acquireLaunchLock: () => Promise.resolve({ kind: 'acquired', release: () => Promise.resolve() }),
    acquireBuildLock: () => Promise.resolve({ kind: 'acquired', release: () => Promise.resolve() }),
    findRunningServer: () => {
      if (w.found !== undefined) return Promise.resolve(w.found);
      const lock = state.current.lock;
      if (lock === null) return Promise.resolve({ kind: 'none', reason: 'no_lock', staleLock: null });
      const health = state.current.health.get(lock.port);
      if (health?.kind === 'ok' && health.health.serverInstanceId === lock.serverInstanceId) {
        return Promise.resolve({ kind: 'running', lock, health: health.health });
      }
      return Promise.resolve({ kind: 'none', reason: 'unreachable', staleLock: lock });
    },
    checkHealth: (port) =>
      Promise.resolve(state.current.health.get(port) ?? { kind: 'down', reason: 'ECONNREFUSED' }),
    readLock: () =>
      Promise.resolve(
        state.current.lock === null ? { kind: 'missing' } : { kind: 'ok', lock: state.current.lock },
      ),
    requestCode: (_port, token) =>
      Promise.resolve(
        token === state.current.lock?.launcherToken
          ? { kind: 'ok', response: sampleLauncherCode({ code: sampleToken(now + 10) }) }
          : { kind: 'token_invalid' },
      ),
    expectedBuildId: () => Promise.resolve('1.0.0+abc'),
    checkBuild: (expected) => Promise.resolve({ upToDate: true, buildId: expected ?? '' }),
    runBuild: () => {
      state.builds += 1;
      return Promise.resolve({ ok: true });
    },
    probePort: () => Promise.resolve('free'),
    startServer: (args) => {
      state.started.push(args);
      const exited = new Promise<ServerExit>((resolve) => {
        resolveExit = resolve;
      });
      const behaviour = w.onStart ?? { readyAfterMs: 300 };
      if ('readyAfterMs' in behaviour) {
        readyAt = now + behaviour.readyAfterMs;
        pendingLock = sampleServerLockFile({
          pid: SERVER_PID,
          port: behaviour.port ?? 4711,
          serverInstanceId: sampleUuid(99),
          launcherToken: sampleToken(99),
        });
      } else if ('exit' in behaviour) {
        exitAt = { at: now + 200, exit: behaviour.exit };
      }
      const started: StartedServer = { pid: SERVER_PID, exited, outLogOffset: 0 };
      return Promise.resolve(started);
    },
    readServerOutput: () =>
      Promise.resolve(w.onStart !== undefined && 'output' in w.onStart ? (w.onStart.output ?? '') : ''),
    locateEdge: () => Promise.resolve(EDGE),
    openEdge: (edge, args) => {
      state.edgeCalls.push({ edge, args });
      return Promise.resolve({ pid: 777 });
    },
    edgeProfileSignedIn: () => Promise.resolve(false),
    allowNotifications: (home, origin) => {
      state.grants.push({ home, origin });
      return Promise.resolve({ kind: 'granted' });
    },
    sleep: (ms) => {
      tick(ms);
      return Promise.resolve();
    },
    now: () => now,
    out: (line) => state.out.push(line),
    ...w.overrides,
  };
  return Object.assign(state, { deps });
}

async function failure(promise: Promise<unknown>): Promise<LauncherError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LauncherError) return error;
    throw error;
  }
  throw new Error('expected a LauncherError');
}

function codeOf(url: string): string | null {
  return takeAuthCodeFromHash(new URL(url).hash).code;
}

describe('launcher: fresh start (architecture §5.1 (h))', () => {
  it('starts the server, waits for lock + health, opens an Edge app window with a code', async () => {
    const w = world();
    const result = await runLauncher(options(), w.deps);
    expect(result).toEqual({
      mode: 'started',
      port: 4711,
      pid: SERVER_PID,
      url: null,
      edgePid: 777,
      window: true,
    });
    expect(w.started).toEqual([[`--home=${HOME}`, '--port=4711']]);
    expect(w.builds).toBe(0);
    expect(w.edgeCalls).toHaveLength(1);
    const args = w.edgeCalls[0]?.args ?? [];
    expect(w.edgeCalls[0]?.edge).toBe(EDGE);
    // The own profile without sign-in/sync (V2-01), the code URL last.
    expect(args.slice(0, -1)).toEqual(edgeAppArgs({ home: HOME, url: 'x' }).slice(0, -1));
    expect(args).toContain(`--user-data-dir=${edgeProfileDir(HOME)}`);
    expect(args).toContain('--disable-sync');
    expect(args.at(-1)).toMatch(/^--app=http:\/\/127\.0\.0\.1:4711\/#code=[A-Za-z0-9_-]{43}$/);
    expect(codeOf((args.at(-1) ?? '').slice('--app='.length))).not.toBeNull();
  });

  it('WP22-03: allows notifications for the server origin in the own profile before Edge opens', async () => {
    const w = world();
    await runLauncher(options(), w.deps);
    expect(w.grants).toEqual([{ home: HOME, origin: 'http://127.0.0.1:4711' }]);
    expect(w.out.join('\n')).not.toContain('notifications');
    const skipped = world({
      overrides: { allowNotifications: () => Promise.resolve({ kind: 'skipped', reason: 'locked' }) },
    });
    await runLauncher(options(), skipped.deps);
    expect(skipped.edgeCalls).toHaveLength(1);
    expect(skipped.out.join('\n')).toContain('notifications could not be allowed');
  });

  it('a profile signed in by an earlier version gets a note (V2-01); a fresh one none', async () => {
    const w = world({ overrides: { edgeProfileSignedIn: () => Promise.resolve(true) } });
    await runLauncher(options(), w.deps);
    expect(w.out.join('\n')).toContain('is signed in to an account from an earlier Parallax version');
    const fresh = world();
    await runLauncher(options(), fresh.deps);
    expect(fresh.out.join('\n')).not.toContain('signed in');
  });

  it('with port 0 skips the port probe and uses the port from the lock file', async () => {
    let probed = false;
    const w = world({
      onStart: { readyAfterMs: 100, port: 51234 },
      overrides: {
        probePort: () => {
          probed = true;
          return Promise.resolve('in_use');
        },
      },
    });
    const result = await runLauncher(options({ port: 0, printUrl: true }), w.deps);
    expect(probed).toBe(false);
    expect(result.port).toBe(51234);
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:51234\/#code=/);
    expect(w.edgeCalls).toEqual([]);
    expect(w.out.join('\n')).toContain('within 60 seconds');
  });

  it('builds first when dist is missing or stale', async () => {
    for (const reason of ['missing', 'stale', 'unknown'] as const) {
      const w = world({
        overrides: {
          checkBuild: () => Promise.resolve({ upToDate: false, reason, bundled: null, expected: null }),
        },
      });
      await runLauncher(options(), w.deps);
      expect(w.builds).toBe(1);
      expect(w.out[0]).toMatch(/^Building Parallax/);
    }
  });

  it('skips the build check with --no-build', async () => {
    let checked = false;
    const w = world({
      overrides: {
        checkBuild: () => {
          checked = true;
          return Promise.resolve({ upToDate: false, reason: 'missing', bundled: null, expected: null });
        },
      },
    });
    await runLauncher(options({ build: false }), w.deps);
    expect(checked).toBe(false);
    expect(w.builds).toBe(0);
  });

  it('a failed build stops before the server start', async () => {
    const w = world({
      overrides: {
        checkBuild: () =>
          Promise.resolve({ upToDate: false, reason: 'missing', bundled: null, expected: null }),
        runBuild: () => Promise.resolve({ ok: false, step: 'build:server', output: 'line1\nerror TS1234' }),
      },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('build_failed');
    expect(error.message).toContain('build:server');
    expect(error.message).toContain('error TS1234');
    expect(error.exitCode).toBe(1);
    expect(w.started).toEqual([]);
  });
});

describe('launcher: server already running (architecture §5.1 (i))', () => {
  const running = sampleServerLockFile({ port: 4711, pid: 4242 });

  it('opens only another window with a fresh code, starts and builds nothing', async () => {
    let buildChecked = false;
    const w = world({
      running,
      overrides: {
        checkBuild: () => {
          buildChecked = true;
          return Promise.resolve({ upToDate: true, buildId: 'x' });
        },
      },
    });
    const result = await runLauncher(options(), w.deps);
    expect(result).toMatchObject({ mode: 'existing', port: 4711, pid: 4242 });
    expect(w.started).toEqual([]);
    expect(buildChecked).toBe(false);
    expect(w.edgeCalls).toHaveLength(1);
  });

  it('hints at a different requested port and at an older running build', async () => {
    const w = world({ running });
    w.current.health.set(4711, okHealth(running, { buildId: '0.9.0+old' }));
    await runLauncher(options({ port: 5000 }), w.deps);
    expect(w.out.join('\n')).toContain('already runs on port 4711');
    expect(w.out.join('\n')).toContain('older build (0.9.0+old');
  });

  it('a rejected launcher token is a clear error (lock file of another server)', async () => {
    const w = world({
      running,
      overrides: { requestCode: () => Promise.resolve({ kind: 'token_invalid' }) },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('launcher_code_failed');
    expect(error.message).toContain('rejected the launcher token');
  });

  it('a busy server: the code request is retried with backoff (R2-14)', async () => {
    const answers: LauncherCodeResult[] = [
      { kind: 'failed', reason: 'ETIMEDOUT' },
      { kind: 'failed', reason: 'ECONNRESET' },
      { kind: 'ok', response: sampleLauncherCode({ code: sampleToken(99) }) },
    ];
    const slept: number[] = [];
    let calls = 0;
    const w = world({
      running,
      overrides: {
        requestCode: () => {
          calls += 1;
          return Promise.resolve(answers.shift() ?? { kind: 'failed', reason: 'none' });
        },
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await runLauncher(options(), w.deps);
    expect(result.mode).toBe('existing');
    expect(calls).toBe(3);
    expect(slept).toEqual(CODE_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the retries; a rejected token is never retried', async () => {
    let calls = 0;
    const w = world({
      running,
      overrides: {
        requestCode: () => {
          calls += 1;
          return Promise.resolve({ kind: 'failed', reason: 'ETIMEDOUT' });
        },
      },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('launcher_code_failed');
    expect(error.message).toContain('ETIMEDOUT');
    expect(calls).toBe(CODE_RETRY_DELAYS_MS.length + 1);

    let tokenCalls = 0;
    const rejected = world({
      running,
      overrides: {
        requestCode: () => {
          tokenCalls += 1;
          return Promise.resolve({ kind: 'token_invalid' });
        },
      },
    });
    await failure(runLauncher(options(), rejected.deps));
    expect(tokenCalls).toBe(1);
  });
});

describe('launcher: stale lock file (health ping instead of PID check)', () => {
  it('a crashed server (nothing answers) is ignored and a new server is started', async () => {
    const stale = sampleServerLockFile({ port: 4711, pid: 1111, serverInstanceId: sampleUuid(5) });
    const w = world({ running: stale });
    w.current.health.delete(4711);
    const result = await runLauncher(options(), w.deps);
    expect(result).toMatchObject({ mode: 'started', pid: SERVER_PID });
    expect(w.out[0]).toContain('stale lock file');
  });

  it('waits for the lock file of the NEW process (same PID), not the stale one', async () => {
    const stale = sampleServerLockFile({ port: 4711, pid: 1111, serverInstanceId: sampleUuid(5) });
    const w = world({ running: stale, onStart: { readyAfterMs: 1_000 } });
    w.current.health.delete(4711);
    let polls = 0;
    const readLock = w.deps.readLock.bind(w.deps);
    w.deps.readLock = (home) => {
      polls += 1;
      return readLock(home);
    };
    const result = await runLauncher(options(), w.deps);
    expect(result.pid).toBe(SERVER_PID);
    expect(polls).toBeGreaterThanOrEqual(10);
  });
});

describe('launcher: start failures', () => {
  it('port taken by another program (probe)', async () => {
    const w = world({ overrides: { probePort: () => Promise.resolve('in_use') } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('port_in_use');
    expect(error.message).toContain('Port 4711 is already in use by another program');
    expect(error.message).toContain('--port=<n>');
    expect(w.started).toEqual([]);
  });

  it('port taken by another Parallax server (other data directory)', async () => {
    const w = world({ overrides: { probePort: () => Promise.resolve('in_use') } });
    w.current.health.set(4711, okHealth(sampleServerLockFile()));
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.message).toContain('another Parallax server');
  });

  it('port held by a hanging earlier server names its PID', async () => {
    const stale = sampleServerLockFile({ port: 4711, pid: 1111 });
    const w = world({
      found: { kind: 'none', reason: 'unreachable', staleLock: stale },
      overrides: { probePort: () => Promise.resolve('in_use') },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.message).toContain('taskkill /PID 1111 /T /F');
  });

  it('a reserved port (EACCES)', async () => {
    const w = world({ overrides: { probePort: () => Promise.resolve('denied') } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('port_denied');
    expect(error.message).toContain('excludedportrange');
  });

  it('exit code 3 = data of a newer Parallax → "update Parallax", launcher exit code 3', async () => {
    const w = world({
      onStart: {
        exit: { code: 3, signal: null },
        output: 'sessions.json was written by a newer Parallax (schemaVersion 2) - update Parallax.',
      },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('store_too_new');
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('Update Parallax');
    expect(error.message).toContain('Server output: sessions.json was written by a newer Parallax');
    expect(w.edgeCalls).toEqual([]);
  });

  it('exit code 4 or EADDRINUSE in the output = port in use (race after the probe)', async () => {
    for (const onStart of [
      { exit: { code: 4, signal: null } },
      { exit: { code: 1, signal: null }, output: '{"err":{"code":"EADDRINUSE"}}' },
    ]) {
      const w = world({ onStart });
      const error = await failure(runLauncher(options(), w.deps));
      expect(error.reason).toBe('port_in_use');
    }
  });

  it('double start: the loser (exit 4/5) opens a window of the winner instead of failing', async () => {
    const winner = sampleServerLockFile({ port: 4711, pid: 6000, serverInstanceId: sampleUuid(42) });
    for (const code of [4, 5]) {
      let checks = 0;
      const w = world({ onStart: { exit: { code, signal: null } } });
      const find = w.deps.findRunningServer.bind(w.deps);
      w.deps.findRunningServer = (home) => {
        checks += 1;
        if (checks === 1) return find(home);
        // Meanwhile the other launcher's server is up.
        w.current.lock = winner;
        w.current.health.set(4711, okHealth(winner));
        return find(home);
      };
      const result = await runLauncher(options(), w.deps);
      expect(result).toMatchObject({ mode: 'existing', pid: 6000 });
      expect(w.edgeCalls).toHaveLength(1);
    }
  });

  it('exit 5 without a running server asks to try again', async () => {
    const w = world({ onStart: { exit: { code: 5, signal: null } } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('server_exited');
    expect(error.message).toContain('start Parallax again in a moment');
  });

  it('any other exit names the log files', async () => {
    const w = world({
      onStart: { exit: { code: 1, signal: null }, output: 'Error: Cannot find module x\n' },
    });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('server_exited');
    expect(error.message).toContain('exit code 1');
    expect(error.message).toContain(`${HOME}\\logs\\server.out.log`);
    expect(error.message).toContain('Server output: Error: Cannot find module x');
  });

  it('a server that never becomes ready times out with PID and log path', async () => {
    const w = world({ onStart: { hang: true } });
    const error = await failure(runLauncher(options({ readyTimeoutMs: 1_000 }), w.deps));
    expect(error.reason).toBe('server_timeout');
    expect(error.message).toContain(`PID ${String(SERVER_PID)}`);
    expect(error.message).toContain('server.out.log');
  });

  it('a spawn failure (node.exe missing)', async () => {
    const w = world({ overrides: { startServer: () => Promise.reject(new Error('spawn ENOENT')) } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('server_start_failed');
    expect(error.message).toContain('spawn ENOENT');
  });
});

describe('launcher: Edge', () => {
  it('Edge not found: the server keeps running, the message offers --print-url', async () => {
    const w = world({ overrides: { locateEdge: () => Promise.resolve(null) } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('edge_not_found');
    expect(error.message).toContain('Microsoft Edge was not found');
    expect(error.message).toContain('--print-url');
    expect(error.message).toContain(`PID ${String(SERVER_PID)}`);
    // The code never appears in an error message.
    expect(error.message).not.toContain('#code=');
  });

  it('Edge cannot be started', async () => {
    const w = world({ overrides: { openEdge: () => Promise.reject(new Error('spawn EACCES')) } });
    const error = await failure(runLauncher(options(), w.deps));
    expect(error.reason).toBe('edge_failed');
    expect(error.message).toContain('spawn EACCES');
  });
});

describe('launcher: backend of a running server (R3-02)', () => {
  const running = sampleServerLockFile({ port: 4711, pid: 4242 });

  it('another backend than requested is a clear error, no window', async () => {
    const w = world({ running });
    w.current.health.set(4711, okHealth(running, { backend: 'fake' }));
    const error = await failure(runLauncher(options({ backend: 'sdk' }), w.deps));
    expect(error.reason).toBe('backend_mismatch');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('with the FakeBackend (--backend=fake)');
    expect(error.message).toContain('real claude backend (--backend=sdk)');
    expect(error.message).toContain('"parallax --backend=fake" opens a window of it');
    expect(error.message).toContain('PID 4242');
    expect(w.edgeCalls).toEqual([]);
  });

  it('the same backend, an unknown one (older server) or no request open the window', async () => {
    for (const [backend, requested] of [
      ['fake', 'fake'],
      [undefined, 'sdk'],
      ['fake', undefined],
    ] as const) {
      const w = world({ running });
      w.current.health.set(4711, okHealth(running, backend === undefined ? {} : { backend }));
      const result = await runLauncher(
        options(requested === undefined ? {} : { backend: requested }),
        w.deps,
      );
      expect(result.mode).toBe('existing');
      expect(w.edgeCalls).toHaveLength(1);
    }
  });
});

describe('launcher: concurrent starts (R3-04)', () => {
  it('a second launcher waits for the first one, then opens only a window of its server', async () => {
    const winner = sampleServerLockFile({ port: 4711, pid: 6000, serverInstanceId: sampleUuid(42) });
    let tries = 0;
    const w = world();
    w.deps.acquireLaunchLock = () => {
      tries += 1;
      if (tries < 4) return Promise.resolve({ kind: 'busy' });
      // Meanwhile the first launcher's server became ready and it released the lock.
      w.current.lock = winner;
      w.current.health.set(4711, okHealth(winner));
      return Promise.resolve({ kind: 'acquired', release: () => Promise.resolve() });
    };
    const result = await runLauncher(options(), w.deps);
    expect(result).toMatchObject({ mode: 'existing', pid: 6000 });
    expect(w.started).toEqual([]);
    expect(w.edgeCalls).toHaveLength(1);
    expect(w.out[0]).toContain('by another launcher - waiting for it');
  });

  it('the launch lock is released after the run, also after a failure', async () => {
    let released = 0;
    const lock = () =>
      Promise.resolve({
        kind: 'acquired' as const,
        release: () => {
          released += 1;
          return Promise.resolve();
        },
      });
    await runLauncher(options(), world({ overrides: { acquireLaunchLock: lock } }).deps);
    await failure(
      runLauncher(
        options(),
        world({ overrides: { acquireLaunchLock: lock, locateEdge: () => Promise.resolve(null) } }).deps,
      ),
    );
    expect(released).toBe(2);
  });

  it('a launcher that never finishes: clear error after lockWaitMs', async () => {
    const w = world({ overrides: { acquireLaunchLock: () => Promise.resolve({ kind: 'busy' }) } });
    const error = await failure(runLauncher(options({ lockWaitMs: 1_000 }), w.deps));
    expect(error.reason).toBe('launch_busy');
    expect(error.message).toContain('Close its console window');
    expect(w.started).toEqual([]);
  });

  it('a build of the same checkout by another launcher is awaited, not repeated', async () => {
    let tries = 0;
    let built = false;
    const w = world({
      overrides: {
        checkBuild: () =>
          Promise.resolve(
            built
              ? { upToDate: true, buildId: '1.0.0+abc' }
              : { upToDate: false, reason: 'stale', bundled: '1.0.0+old', expected: '1.0.0+abc' },
          ),
        acquireBuildLock: () => {
          tries += 1;
          if (tries < 3) return Promise.resolve({ kind: 'busy' });
          built = true; // the other launcher's build finished
          return Promise.resolve({ kind: 'acquired', release: () => Promise.resolve() });
        },
      },
    });
    await runLauncher(options(), w.deps);
    expect(w.builds).toBe(0);
    expect(w.out[0]).toContain('Another build of this Parallax folder is running');
    expect(w.started).toHaveLength(1);
  });

  it('CR-04: the real build lock of a checkout on a UNC share is no TypeError', async () => {
    const deps = createNodeLauncherDeps({
      repoRoot: `\\\\nas-${String(process.pid)}\\share\\parallax`,
      home: HOME,
      serverScript: 'C:\\repo\\dist\\server.js',
    });
    const lock = await deps.acquireBuildLock();
    expect(lock.kind).toBe('acquired');
    if (lock.kind === 'acquired') await lock.release();
  });

  it('exit 5: the winner is polled until it is ready, then its window opens', async () => {
    const winner = sampleServerLockFile({ port: 4711, pid: 6000, serverInstanceId: sampleUuid(42) });
    const w = world({ onStart: { exit: { code: 5, signal: null } } });
    let polls = 0;
    const find = w.deps.findRunningServer.bind(w.deps);
    w.deps.findRunningServer = (home) => {
      polls += 1;
      // The winner writes its lock file only after stores, recovery and listen (≈ 1–2 s).
      if (polls === 6) {
        w.current.lock = winner;
        w.current.health.set(4711, okHealth(winner));
      }
      return find(home);
    };
    const result = await runLauncher(options(), w.deps);
    expect(result).toMatchObject({ mode: 'existing', pid: 6000 });
    expect(polls).toBeGreaterThanOrEqual(6);
  });

  it('port taken by the server of this home that came up meanwhile: its window, no error', async () => {
    const winner = sampleServerLockFile({ port: 4711, pid: 6000, serverInstanceId: sampleUuid(42) });
    let checks = 0;
    const w = world({ overrides: { probePort: () => Promise.resolve('in_use') } });
    const find = w.deps.findRunningServer.bind(w.deps);
    w.deps.findRunningServer = (home) => {
      checks += 1;
      if (checks === 2) {
        w.current.lock = winner;
        w.current.health.set(4711, okHealth(winner));
      }
      return find(home);
    };
    const result = await runLauncher(options(), w.deps);
    expect(result).toMatchObject({ mode: 'existing', pid: 6000 });
    expect(w.started).toEqual([]);
  });
});

describe('launcher: port hint (V2-13)', () => {
  it('no hint when the port was not asked for', async () => {
    const running = sampleServerLockFile({ port: 4792, pid: 4242 });
    const w = world({ running });
    await runLauncher(options({ port: 4711, portExplicit: false }), w.deps);
    expect(w.out.join('\n')).not.toContain('takes effect after');
  });
});

describe('launcher: Phase 2 --open and --autostart (ADR-109, ADR-110)', () => {
  const ENTRY = SAMPLE_IDS.entry;

  it('--open: the window URL selects the session (fresh start, running server, --print-url)', async () => {
    const fresh = world();
    await runLauncher(options({ entryId: ENTRY }), fresh.deps);
    const app = fresh.edgeCalls[0]?.args.at(-1) ?? '';
    expect(app).toMatch(
      new RegExp(`^--app=http://127\\.0\\.0\\.1:4711/#code=[A-Za-z0-9_-]{43}&session=${ENTRY}$`),
    );
    const { code, hash } = takeAuthCodeFromHash(new URL(app.slice('--app='.length)).hash);
    expect(code).not.toBeNull();
    expect(hash).toBe(`#session=${ENTRY}`);

    const running = sampleServerLockFile({ port: 4711, pid: 4242 });
    const existing = world({ running });
    const result = await runLauncher(options({ entryId: ENTRY, printUrl: true }), existing.deps);
    expect(result).toMatchObject({ mode: 'existing', window: true });
    expect(result.url).toMatch(new RegExp(`&session=${ENTRY}$`));
    expect(existing.started).toEqual([]);
  });

  it('--autostart without a window: the server starts, no code, no Edge', async () => {
    let codes = 0;
    const w = world();
    const requestCode = w.deps.requestCode.bind(w.deps);
    w.deps.requestCode = (port, token) => {
      codes += 1;
      return requestCode(port, token);
    };
    const result = await runLauncher(options({ openWindow: false }), w.deps);
    expect(result).toEqual({
      mode: 'started',
      port: 4711,
      pid: SERVER_PID,
      url: null,
      edgePid: null,
      window: false,
    });
    expect(w.started).toHaveLength(1);
    expect(codes).toBe(0);
    expect(w.edgeCalls).toEqual([]);
    expect(w.grants).toEqual([]);
    // A server that already runs: nothing at all.
    const running = sampleServerLockFile({ port: 4711, pid: 4242 });
    const again = world({ running });
    expect(await runLauncher(options({ openWindow: false }), again.deps)).toMatchObject({
      mode: 'existing',
      window: false,
    });
    expect(again.edgeCalls).toEqual([]);
  });

  it('--autostart with a window: like a normal start', async () => {
    const w = world();
    expect(await runLauncher(options({ openWindow: true }), w.deps)).toMatchObject({
      window: true,
      edgePid: 777,
    });
    expect(w.edgeCalls).toHaveLength(1);
  });
});
