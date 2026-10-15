import { describe, expect, it } from 'vitest';
import { takeAuthCodeFromHash, type ServerLockFile } from '@shared/http';
import {
  sampleHealthResponse,
  sampleLauncherCode,
  sampleServerLockFile,
  sampleToken,
  sampleUuid,
} from '@shared/samples';
import type { HealthCheck, RunningServerCheck } from './client';
import { edgeProfileDir } from './edgeWindow';
import { LauncherError, runLauncher, type LauncherDeps, type LauncherOptions } from './launcher';
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
    expect(result).toEqual({ mode: 'started', port: 4711, pid: SERVER_PID, url: null, edgePid: 777 });
    expect(w.started).toEqual([[`--home=${HOME}`, '--port=4711']]);
    expect(w.builds).toBe(0);
    expect(w.edgeCalls).toHaveLength(1);
    const args = w.edgeCalls[0]?.args ?? [];
    expect(w.edgeCalls[0]?.edge).toBe(EDGE);
    expect(args).toEqual([
      `--user-data-dir=${edgeProfileDir(HOME)}`,
      '--no-first-run',
      '--no-default-browser-check',
      expect.stringMatching(/^--app=http:\/\/127\.0\.0\.1:4711\/#code=[A-Za-z0-9_-]{43}$/),
    ]);
    expect(codeOf((args[3] ?? '').slice('--app='.length))).not.toBeNull();
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
