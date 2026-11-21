/**
 * Launcher entry point. In a checkout it runs with tsx from the repo root:
 * `node node_modules/tsx/dist/cli.mjs --tsconfig src/server/tsconfig.json src/server/launcher/main.ts`
 * (`parallax.cmd`, `parallax.ps1`, the autostart shortcut with `--autostart` and the protocol
 * handler with `--open "%1"`, ADR-109/110). In a release package it is bundled to `dist/launcher.js`
 * (WP-85, `scripts/build-launcher.ts`) and `release.json` next to `dist/` switches on package mode.
 * Not part of the server bundle. The flow and the exit codes live in cli.ts (0 = done, 2 = bad
 * option or link, 3 = data of a newer Parallax, else 1).
 *
 * WP-87b: with `--apply-update` this process is the orchestrator of a version switch
 * (applyUpdate.ts), started by the server with stdout as a pipe that carries only the handshake –
 * the server closes it right after. So in that mode nothing else is written to stdout (the pino
 * singleton is silenced) and a failing write to the closed pipe never crashes the process.
 *
 * WP-107: `--server` keeps this process in the foreground with the server (signals passed on, exit
 * code = the server's), `service …` writes the systemd user unit with the command that started this
 * launcher, `remote …` asks the running server of the data folder.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { START_SCRIPT } from '../install/layout';
import { acquireDirectoryLock } from '../lib/homeLock';
import { logger } from '../lib/logger';
import { isProcessAlive } from '../lib/process';
import { createProcfsReader, isEndedState } from '../lib/procfs';
import { createNodeApplyUpdateDeps, runApplyUpdate } from './applyUpdate';
import { SERVER_BUNDLE } from './build';
import { runLauncherCli, type ServeOutcome, type ServeRequest } from './cli';
import { findRunningServer, requestLauncherRemote } from './client';
import { createNodeLauncherDeps, runLauncher } from './launcher';
import { PACKAGE_NODE_FLAGS, readReleaseInfo, ReleaseInfoError, type ReleaseInfo } from './release';
import { startServerForeground, type ForegroundServer } from './serverProcess';
import {
  adoptRunning,
  createSignalRelay,
  listenProcessSignals,
  superviseServer,
  type SuperviseDeps,
} from './supervise';
import { installService, serviceStatus, uninstallService, type ServiceDeps } from './systemdService';

// Like the server (main.ts): dist/launcher.js → `..`, src/server/launcher/main.ts → `../../..`.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, path.basename(here) === 'dist' ? '..' : path.join('..', '..', '..'));

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** One line to stdout; false when it could not be delivered (the reader closed the pipe). */
function handshake(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`${line}\n`, (error) => {
        resolve(error === undefined || error === null);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Orchestrator mode: stdout is the handshake pipe only (see the file comment). */
function quietForHandshake(): void {
  logger.level = 'silent';
  const ignore = (): void => undefined;
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
}

/**
 * WP-107: the command that starts this launcher again (the systemd unit): the installation's
 * start.mjs, the bundled launcher of a package, or tsx with this file in a checkout.
 */
function launcherCommand(release: ReleaseInfo | null, installRoot: string | null): string[] {
  if (installRoot !== null) return [process.execPath, path.join(installRoot, START_SCRIPT)];
  if (release !== null)
    return [process.execPath, ...PACKAGE_NODE_FLAGS, path.join(repoRoot, 'dist', 'launcher.js')];
  return [
    process.execPath,
    path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--tsconfig',
    path.join(repoRoot, 'src', 'server', 'tsconfig.json'),
    path.join(repoRoot, 'src', 'server', 'launcher', 'main.ts'),
  ];
}

/** WP-109: the seams of `superviseServer` for this process. */
function superviseDeps(home: string): SuperviseDeps {
  const procfs = createProcfsReader();
  return {
    platform: process.platform,
    home,
    findRunning: () => findRunningServer({ home }),
    launchLockFree: async () => {
      const attempt = await acquireDirectoryLock('launch', home);
      if (attempt.kind === 'busy') return false;
      await attempt.lock.release();
      return true;
    },
    identity: (pid) => {
      if (process.platform !== 'linux') return isProcessAlive(pid) ? 0 : null;
      const row = procfs.stat(pid);
      return row === null || isEndedState(row.state) ? null : row.startTicks;
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out,
  };
}

/**
 * WP-107 `--server`: like a window start, but the server stays attached to this process. WP-109:
 * signals are taken from the start, a running server and the successor of an update are adopted on
 * POSIX (supervise.ts).
 */
async function serve(release: ReleaseInfo | null, request: ServeRequest): Promise<ServeOutcome> {
  const { options } = request;
  const relay = createSignalRelay(listenProcessSignals);
  const deps = superviseDeps(options.home);
  try {
    const running = await findRunningServer({ home: options.home });
    if (running.kind === 'running') {
      const adopted = adoptRunning(running.lock.port, running.lock.pid, deps);
      if (adopted === null) return { kind: 'existing', port: running.lock.port, pid: running.lock.pid };
      return { kind: 'ended', code: await superviseServer(adopted, relay, deps) };
    }
    if (relay.stopRequested) return { kind: 'ended', code: 0 };
    // Set inside `startServer` (a holder: a closure assignment is invisible to the flow analysis).
    const holder: { server: ForegroundServer | null } = { server: null };
    const base = createNodeLauncherDeps({
      repoRoot,
      release,
      workDir: options.installRoot ?? null,
      home: options.home,
      serverScript: path.join(repoRoot, SERVER_BUNDLE),
      out,
    });
    const result = await runLauncher(options, {
      ...base,
      startServer: async (args) => {
        const server = await startServerForeground({
          nodePath: process.execPath,
          serverScript: path.join(repoRoot, SERVER_BUNDLE),
          nodeArgs: release === null ? [] : PACKAGE_NODE_FLAGS,
          args,
          home: options.home,
          cwd: options.installRoot ?? repoRoot,
          env: process.env,
        });
        holder.server = server;
        // A stop during the start reaches the server at once.
        relay.attach(server);
        return server;
      },
      // Its output is on this console already.
      readServerOutput: () => Promise.resolve(''),
    });
    const started = holder.server;
    if (result.mode === 'existing' || started === null) {
      const adopted = adoptRunning(result.port, result.pid, deps);
      if (adopted === null) return { kind: 'existing', port: result.port, pid: result.pid };
      return { kind: 'ended', code: await superviseServer(adopted, relay, deps) };
    }
    request.onStarted(result);
    return { kind: 'ended', code: await superviseServer(started, relay, deps) };
  } finally {
    relay.dispose();
  }
}

// lib/* modules log through the pino singleton; the console belongs to the launcher's messages.
logger.level = 'error';
try {
  const release = await readReleaseInfo(repoRoot);
  process.exitCode = await runLauncherCli(process.argv.slice(2), {
    env: process.env,
    out,
    fail,
    launch: (options) =>
      runLauncher(
        options,
        createNodeLauncherDeps({
          repoRoot,
          release,
          workDir: options.installRoot ?? null,
          home: options.home,
          serverScript: path.join(repoRoot, SERVER_BUNDLE),
          out,
        }),
      ),
    applyUpdate: (request) => {
      quietForHandshake();
      return runApplyUpdate(
        request,
        createNodeApplyUpdateDeps({ own: { release, dir: repoRoot }, home: request.home, handshake }),
      );
    },
    serve: (request) => serve(release, request),
    remote: async (home, request) => {
      const running = await findRunningServer({ home });
      if (running.kind !== 'running') return { kind: 'not_running' };
      return requestLauncherRemote(running.lock.port, running.lock.launcherToken, request);
    },
    service: (request) => {
      const deps: ServiceDeps = { platform: process.platform, env: process.env, out };
      if (request.action === 'uninstall') return uninstallService(deps);
      if (request.action === 'status') return serviceStatus(deps);
      return installService(
        {
          command: launcherCommand(release, request.installRoot),
          serverArgs: request.serverArgs,
          workDir: request.installRoot ?? repoRoot,
          ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
        },
        deps,
      );
    },
  });
} catch (error) {
  if (!(error instanceof ReleaseInfoError)) throw error;
  fail(`This Parallax installation is damaged: ${error.message}. Install Parallax again.`);
  process.exitCode = 1;
}
// Nothing may keep the launcher alive (server and Chrome are detached and unref'd).
setTimeout(() => {
  process.exit();
}, 2_000).unref();
