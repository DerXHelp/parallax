/**
 * Update E2E (WP-89e): an installation root with version A, started like `parallax.cmd`
 * (`node <PACKAGE_NODE_FLAGS> <root>\start.mjs --print-url …`), and the checks around a restart.
 *
 * - **Version A** is staged in-process with `stageVersion` + `switchVersion` and the test key: the
 *   installer bundle (`install.js`) checks with the release keys of its own code only and would
 *   create a Start menu entry – neither fits a test package. The SDK comes from the mini tarball
 *   (`provideSdk` with `tarball`), which also fills `<root>\cache` for the later versions.
 * - **Environment** of launcher, server, orchestrator and every later server: no inherited
 *   PARALLAX_*, `NODE_ENV=test` (contract validation, test-run guards), the switches of the update
 *   test build (release server, test key, registry), toasts off, loopback without a proxy, and an
 *   isolated npm (`offline`, own cache and user config): npm next to Node never goes to a network,
 *   the SDK step falls back to its own download from the fake registry.
 * - **Fixed port** (free at the start): after an update the window reconnects only to the same origin.
 */
import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { serverOrigin, type ServerLockFile } from '@shared/http';
import { checkHealth } from '../../src/server/launcher/client';
import { readServerLock } from '../../src/server/launcher/lockFile';
import { PACKAGE_NODE_FLAGS } from '../../src/server/launcher/release';
import { stageVersion, switchVersion } from '../../src/server/install/install';
import { CURRENT_FILE, START_SCRIPT } from '../../src/server/install/layout';
import { provideSdk } from '../../src/server/install/sdk';
import type { TestKey } from '../../src/server/install/testPackage';
import { sleep } from '../../src/server/lib/async';
import {
  childProcesses,
  isProcessAlive,
  killProcessTree,
  processStartTime,
} from '../../src/server/lib/process';
import { adoptE2eServer, type E2eServer } from './server';
import type { MiniSdk, TestPackage } from './update-packages';
import type { ReleaseServer } from './update-release-server';

export interface Installation {
  /** `<repo>\test-results\update-e2e\root` */
  readonly root: string;
  /** PARALLAX_HOME of every server of the installation (OS temp). */
  readonly home: string;
  readonly port: number;
  readonly origin: string;
  /** Scratch folder of the run (launcher output, npm cache, projects). */
  readonly work: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A free TCP port on 127.0.0.1 right now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  return address.port;
}

function withoutKeys(env: NodeJS.ProcessEnv, drop: (upper: string) => boolean): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!drop(key.toUpperCase())) out[key] = value;
  return out;
}

/** The environment of every process of the installation (see the file comment). */
export async function installationEnv(options: {
  work: string;
  key: TestKey;
  release: ReleaseServer;
}): Promise<NodeJS.ProcessEnv> {
  const npmDir = path.join(options.work, 'npm');
  await mkdir(path.join(npmDir, 'cache'), { recursive: true });
  const npmrc = path.join(npmDir, 'npmrc');
  await writeFile(npmrc, '');
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter((part): part is string => part !== undefined && part !== '')
    .join(',');
  const env = withoutKeys(
    process.env,
    (upper) =>
      upper.startsWith('PARALLAX') ||
      upper === 'VITEST' ||
      upper.startsWith('VITEST_') ||
      upper.startsWith('NPM_CONFIG_') ||
      upper === 'NO_PROXY',
  );
  return {
    ...env,
    NODE_ENV: 'test',
    NO_PROXY: noProxy,
    PARALLAX_TEST_UPDATE_BASE: options.release.base,
    PARALLAX_TEST_RELEASE_KEYS: options.key.x,
    PARALLAX_TEST_REGISTRY: options.release.registry,
    PARALLAX_TOASTS: 'off',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_CACHE: path.join(npmDir, 'cache'),
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: npmrc,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
  };
}

/** Stages `pkg` (version A) into the empty `root` with the test key and switches to it. */
export async function installFirstVersion(options: {
  root: string;
  pkg: TestPackage;
  key: TestKey;
  sdk: MiniSdk;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}): Promise<void> {
  await mkdir(options.root, { recursive: true });
  await stageVersion(
    { packageDir: options.pkg.dir, root: options.root, keys: [options.key.x] },
    {
      provideSdk: async (request) =>
        (await provideSdk({ ...request, tarball: options.sdk.tarball, env: options.env, log: options.log }))
          .source,
      log: options.log,
    },
  );
  await switchVersion(options.root, options.pkg.version, { previous: null, log: options.log });
}

/** `<root>\current.json` as bytes and parsed. */
export async function readCurrentFile(root: string): Promise<{ text: string; json: unknown }> {
  const text = await readFile(path.join(root, CURRENT_FILE), 'utf8');
  return { text, json: JSON.parse(text) };
}

const LAUNCHER_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 180_000;
const ORCHESTRATOR_EXIT_MS = 60_000;

let launches = 0;

/**
 * `node <PACKAGE_NODE_FLAGS> <root>\start.mjs --print-url --backend=fake …` like parallax.cmd (no
 * shell): waits for the launcher's exit (its output goes to a file – the detached server inherits
 * the handles) and adopts the server it started. Returns that server and the sign-in URL.
 */
export async function startInstalled(inst: Installation): Promise<{ server: E2eServer; url: string }> {
  launches += 1;
  const outFile = path.join(inst.work, `launcher-${String(launches)}.out.txt`);
  const out = await open(outFile, 'w');
  const startedAt = new Date(Date.now() - 1000);
  const launcher = spawn(
    process.execPath,
    [
      ...PACKAGE_NODE_FLAGS,
      path.join(inst.root, START_SCRIPT),
      '--print-url',
      '--backend=fake',
      '--toasts=off',
      '--system-integration=off',
      `--port=${String(inst.port)}`,
      `--home=${inst.home}`,
    ],
    { cwd: inst.root, env: inst.env, stdio: ['ignore', out.fd, out.fd], windowsHide: true, shell: false },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (launcher.pid !== undefined) void killProcessTree(launcher.pid);
      reject(new Error(`launcher did not exit within ${String(LAUNCHER_TIMEOUT_MS)} ms`));
    }, LAUNCHER_TIMEOUT_MS);
    launcher.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    launcher.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  }).finally(() => out.close());
  const text = await readFile(outFile, 'utf8');
  if (code !== 0) throw new Error(`launcher exited with ${String(code)}:\n${text}`);
  const url = /Open this address within 60 seconds[^:]*: (http:\/\/127\.0\.0\.1:\d+\/#code=\S+)/u.exec(
    text,
  )?.[1];
  if (url === undefined) throw new Error(`no sign-in URL in the launcher output:\n${text}`);
  if (!url.startsWith(`${inst.origin}/#code=`)) throw new Error(`sign-in URL on another origin: ${url}`);
  const server = await adoptE2eServer({ root: path.join(inst.work, 'projects'), home: inst.home, startedAt });
  return { server, url };
}

/** Lock file of a healthy server of `home` other than `oldPid`, or null. */
async function readyLock(home: string, oldPid: number): Promise<ServerLockFile | null> {
  const read = await readServerLock(home);
  if (read.kind !== 'ok' || read.lock.pid === oldPid) return null;
  const health = await checkHealth(read.lock.port);
  return health.kind === 'ok' && health.health.serverInstanceId === read.lock.serverInstanceId
    ? read.lock
    : null;
}

/** Children of `pid` that started after `since` (the orchestrator of a switch); throws if unknown. */
async function youngChildren(pid: number, since: Date): Promise<{ pid: number; name: string }[]> {
  const children = await childProcesses(pid);
  if (children.kind === 'unknown') throw new Error(`child processes unknown: ${children.reason}`);
  return children.processes.filter((p) => p.startedAt >= since);
}

/**
 * After "Restart now" / "Back to …": the server that answers next on the same port (another PID),
 * once the old server process is gone and its orchestrator ended (no process of the switch left).
 */
export async function waitForRestart(inst: Installation, old: E2eServer): Promise<E2eServer> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let lock: ServerLockFile | null = null;
  while (lock === null) {
    if (Date.now() > deadline) throw new Error('no new server after the restart');
    await sleep(250);
    lock = await readyLock(inst.home, old.pid);
  }
  if (lock.port !== inst.port) throw new Error(`the new server listens on ${String(lock.port)}`);
  const exitDeadline = Date.now() + ORCHESTRATOR_EXIT_MS;
  for (;;) {
    const alive = isProcessAlive(old.pid);
    const left = await youngChildren(old.pid, old.startedAt);
    if (!alive && left.length === 0) break;
    if (Date.now() > exitDeadline) {
      for (const child of left) await killProcessTree(child.pid);
      throw new Error(
        `left after the switch: ${alive ? `old server ${String(old.pid)} ` : ''}` +
          left.map((p) => `${p.name} ${String(p.pid)}`).join(', '),
      );
    }
    await sleep(250);
  }
  return adoptE2eServer({
    root: path.join(inst.work, 'projects'),
    home: inst.home,
    startedAt: new Date(Date.parse(lock.startedAt) - 1000),
  });
}

/**
 * Cleanup after a failure: the server of the lock file and every process of a switch still
 * running below the servers seen (orchestrator → new server).
 */
export async function killInstallation(inst: Installation, seen: readonly E2eServer[]): Promise<void> {
  for (const server of seen) {
    const left = await youngChildren(server.pid, server.startedAt).catch(
      (): { pid: number; name: string }[] => [],
    );
    for (const child of left) await killProcessTree(child.pid);
    await killIfOurs(server.pid, server.startedAt);
  }
  const read = await readServerLock(inst.home);
  if (read.kind === 'ok') await killIfOurs(read.lock.pid, new Date(read.lock.startedAt));
}

/** Ends `pid` only if it still is the process that started around `startedAround` (PIDs are reused). */
async function killIfOurs(pid: number, startedAround: Date): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const started = await processStartTime(pid);
  if (started === null) return;
  const offset = started.getTime() - startedAround.getTime();
  if (offset > -10_000 && offset < 60_000) await killProcessTree(pid);
}

/** `<home>\logs\update-*.log` (the orchestrator's logs), oldest first. */
export async function updateLogs(home: string): Promise<{ name: string; text: string }[]> {
  const dir = path.join(home, 'logs');
  const names = (await readdir(dir).catch((): string[] => []))
    .filter((name) => /^update-.+\.log$/u.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(path.join(dir, name), 'utf8') })),
  );
}

export async function removeQuietly(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}

export function originOf(port: number): string {
  return serverOrigin(port);
}
