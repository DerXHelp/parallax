import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { Settings, UpdateState } from '@shared/model';
import type { HostCommand } from '@shared/protocol';
import { SAMPLE_IDS, sampleSettings } from '@shared/samples';
import type { SdkRequest } from '../install/install';
import { DOWNLOADS_DIR, assertNotRealUserFolder, versionDir, writeCurrent } from '../install/layout';
import {
  fakeProvideSdk,
  makeTestKey,
  makeTestPackage,
  testBuildId,
  type TestPackageOptions,
} from '../install/testPackage';
import { nextMacrotask } from '../lib/async';
import type { ReleaseInfo } from '../launcher/release';
import { createBackup } from '../store/backup';
import { CommandError, type CommandContext } from '../sync/ports';
import type { OrchestratorChild } from './apply';
import { APPLY_TIMEOUTS, type OrchestratorCommand } from './handoff';
import { updateResultPath, writeUpdateResult } from './marker';
import type { UpdateService, UpdateServiceOptions } from './ports';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  PROGRESS_THROTTLE_MS,
  RECHECK_SOON_MS,
  createUpdateService,
  type UpdateServiceSeams,
} from './service';
import { UPDATE_STATE_FILE } from './stateFile';
import { FakeReleaseServer, serveRelease, testUpdateEndpoints, zipFolders } from './testRelease';

const temps: string[] = [];
const services: UpdateService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-service-'));
  temps.push(dir);
  return dir;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** Polls `condition` on real timers (unaffected by Vitest fake timers) for up to 30 s. */
async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await realDelay(5);
  }
}

async function commandError(promise: Promise<unknown>): Promise<ErrorPayload> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof CommandError)) throw new Error(`expected a CommandError, got ${String(error)}`);
  return error.error;
}

class FakeChild extends EventEmitter implements OrchestratorChild {
  readonly stdout = new PassThrough();
  readonly unref = vi.fn();
  pid: number | undefined = 4242;
}

const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const OTHER_SCHEMAS = { 'settings.json': 'c'.repeat(64) };
const CHANGELOG_101 =
  '# Changelog\n\n## [1.0.1] – 2026-11-28\n\n### Behoben\n\n- Fix.\n\n## [1.0.0] – 2026-11-20\n\n- First.\n';

interface WorldOptions {
  installed?: boolean;
  previous?: string | null;
  own?: Partial<ReleaseInfo>;
  /** What the orchestrator writes to stdout (null: nothing). */
  handshake?: string | null;
  settings?: Settings;
}

async function world(options: WorldOptions = {}) {
  const base = await temp();
  const root = path.join(base, 'Programs', 'Parallax');
  assertNotRealUserFolder(root);
  const home = path.join(base, 'home');
  await mkdir(home, { recursive: true });
  const key = makeTestKey();
  const endpoints = testUpdateEndpoints([key.x]);
  const server = new FakeReleaseServer();
  const sdk: SdkRequest[] = [];
  const written = await makeTestPackage(versionDir(root, '1.0.0'), {
    version: '1.0.0',
    key,
    files: { 'CHANGELOG.md': CHANGELOG_101, LICENSE: 'MIT License' },
  });
  const own: ReleaseInfo = { ...written, ...options.own };
  const previous = options.previous ?? null;
  if (previous !== null) await makeTestPackage(versionDir(root, previous), { version: previous, key });
  await writeCurrent(root, { schemaVersion: 1, version: '1.0.0', previous });

  let builds = 0;
  const zip = async (version: string, patch: Partial<TestPackageOptions> = {}) => {
    const parent = path.join(base, 'build', String(builds++));
    await makeTestPackage(path.join(parent, `parallax-${version}`), { version, key, ...patch });
    return zipFolders(parent, [`parallax-${version}`], path.join(parent, `parallax-${version}-win.zip`));
  };

  const spawned: OrchestratorCommand[] = [];
  const children: FakeChild[] = [];
  const killed: number[] = [];
  let handshake = options.handshake === undefined ? 'PARALLAX-APPLY-READY\n' : options.handshake;
  let settings = options.settings ?? sampleSettings();
  const restarts = vi.fn();
  const seams: UpdateServiceSeams = {
    fetch: server.fetch,
    endpoints,
    provideSdk: fakeProvideSdk(sdk),
    lockRoot: () => Promise.resolve({ release: () => Promise.resolve() }),
    spawn: (command) => {
      spawned.push(command);
      const child = new FakeChild();
      children.push(child);
      const line = handshake;
      if (line !== null) setImmediate(() => child.stdout.write(line));
      return child;
    },
    kill: (pid) => {
      killed.push(pid);
      return Promise.resolve();
    },
    nodeVersion: '26.12.0',
    nodeExe: NODE_EXE,
    pid: 100,
    handshakeMs: 200,
  };
  const serviceOptions: UpdateServiceOptions = {
    home,
    installRoot: options.installed === false ? null : root,
    repoRoot: versionDir(root, '1.0.0'),
    release: options.installed === false ? null : own,
    instance: {
      serverInstanceId: 'instance-1',
      serverVersion: '1.0.0',
      buildId: options.installed === false ? 'dev' : own.buildId,
      startedAt: '2026-11-17T09:00:00.000Z',
    },
    serverArgs: ['--port=4711'],
    settings: () => settings,
    requestRestart: restarts,
  };
  const create = async (patch: UpdateServiceSeams = {}) => {
    const service = await createUpdateService(serviceOptions, { ...seams, ...patch });
    services.push(service);
    return service;
  };
  const upload = async (bytes: Buffer, service: UpdateService) => {
    const file = service.uploadFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return file;
  };
  return {
    base,
    root,
    home,
    key,
    endpoints,
    server,
    sdk,
    own,
    zip,
    spawned,
    children,
    killed,
    restarts,
    create,
    upload,
    setHandshake: (line: string | null) => {
      handshake = line;
    },
    setSettings: (next: Settings) => {
      settings = next;
    },
  };
}

const check: HostCommand = { name: 'update.check' };
function prepare(version: string): HostCommand {
  return { name: 'update.prepare', version };
}
function apply(version: string, acceptDataLoss = false): HostCommand {
  return { name: 'update.apply', version, acceptDataLoss };
}
function rollback(version: string, acceptDataLoss = false): HostCommand {
  return { name: 'update.rollback', version, acceptDataLoss };
}

function statusOf(service: UpdateService): UpdateState['status'] {
  return service.state().status;
}

const ctx: CommandContext = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };

describe('without an installation (checkout, dev)', () => {
  it('is unsupported: every command NOT_PACKAGED, notes and notices still readable', async () => {
    const w = await world({ installed: false });
    await writeUpdateResult(w.home, {
      schemaVersion: 1,
      outcome: 'pending',
      from: { version: '0.9.0', buildId: testBuildId('0.9.0') },
      to: { version: '1.0.0', buildId: w.own.buildId },
      at: '2026-11-17T09:00:00.000Z',
      backupDir: null,
      error: null,
      log: null,
    });
    const service = await w.create();
    expect(service.app()).toEqual({ version: '1.0.0', buildId: 'dev', packaged: false });
    expect(service.state()).toMatchObject({ status: 'unsupported', justUpdated: null });
    expect(await exists(updateResultPath(w.home))).toBe(true); // the installation's marker stays
    for (const cmd of [check, prepare('1.0.1'), apply('1.0.1'), rollback('0.9.0')]) {
      expect(await commandError(service.handle(cmd, ctx))).toEqual(makeError('UPDATE_NOT_PACKAGED'));
    }
    expect(service.uploadIssue()).toEqual(makeError('UPDATE_NOT_PACKAGED'));
    expect(() => service.uploadFile()).toThrow(CommandError);
    expect((await service.changelog({ for: 'installed' })).sections[0]?.version).toBe('1.0.0');
    expect(await commandError(service.changelog({ for: 'available' }))).toEqual(makeError('FILE_NOT_FOUND'));
    expect(await service.notice('license')).toEqual({ file: 'license', text: 'MIT License' });
    service.start();
    expect(w.server.calls).toHaveLength(0);
  });
});

describe('state from disk', () => {
  it('reads the marker once (justUpdated), the dismissed version and the previous version', async () => {
    const w = await world({ previous: '0.9.0' });
    await writeUpdateResult(w.home, {
      schemaVersion: 1,
      outcome: 'pending',
      from: { version: '0.9.0', buildId: testBuildId('0.9.0') },
      to: { version: '1.0.0', buildId: w.own.buildId },
      at: '2026-11-17T09:00:00.000Z',
      backupDir: null,
      error: null,
      log: null,
    });
    await writeFile(path.join(w.home, UPDATE_STATE_FILE), '{"schemaVersion":1,"dismissedVersion":"1.0.1"}');
    const service = await w.create();
    expect(service.app()).toEqual({ version: '1.0.0', buildId: w.own.buildId, packaged: true });
    expect(service.state()).toMatchObject({
      status: 'idle',
      justUpdated: { from: '0.9.0', to: '1.0.0', at: '2026-11-17T09:00:00.000Z' },
      failedUpdate: null,
      dismissedVersion: '1.0.1',
      previous: { version: '0.9.0', needsRestore: false, backupAt: null },
    });
    expect(await exists(updateResultPath(w.home))).toBe(false);
    expect(await service.handle({ name: 'update.dismiss', what: 'justUpdated' }, ctx)).toEqual({});
    expect(service.state().justUpdated).toBeNull();
    const again = await w.create();
    expect(again.state().justUpdated).toBeNull();
  });
});

describe('check → prepare → apply (GitHub)', () => {
  it('runs the whole way with a real zip and hands over to the orchestrator', async () => {
    const w = await world();
    serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
      changelog: CHANGELOG_101,
    });
    const service = await w.create();
    const statuses: string[] = [];
    service.onChange(() => statuses.push(statusOf(service)));

    expect(await service.handle(check, ctx)).toEqual({ available: '1.0.1' });
    expect(service.state()).toMatchObject({
      status: 'available',
      available: { version: '1.0.1', source: 'github', downgrade: false, needsRestore: false },
      error: null,
    });
    expect(service.state().checkedAt).not.toBeNull();
    expect(await service.changelog({ for: 'available' })).toEqual({
      version: '1.0.1',
      sections: [{ version: '1.0.1', date: '2026-11-28', body: '### Behoben\n\n- Fix.' }],
    });

    expect(await service.handle(prepare('1.0.1'), ctx)).toEqual({});
    expect(await commandError(service.handle(check, ctx))).toMatchObject({ code: 'UPDATE_BUSY' });
    await until(() => statusOf(service) === 'ready', 'ready');
    expect(statuses).toEqual(
      expect.arrayContaining(['checking', 'available', 'downloading', 'preparing', 'ready']),
    );
    expect(await exists(path.join(versionDir(w.root, '1.0.1'), 'release.json'))).toBe(true);
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);

    expect(await commandError(service.handle(apply('1.0.2'), ctx))).toEqual(
      makeError('VALIDATION_FAILED', { reason: 'version' }),
    );
    expect(await service.handle(apply('1.0.1'), ctx)).toEqual({});
    expect(statusOf(service)).toBe('restarting');
    expect(service.orchestratorPid()).toBe(4242);
    expect(w.spawned).toHaveLength(1);
    const command = w.spawned[0];
    expect(command?.file).toBe(NODE_EXE);
    expect(command?.cwd).toBe(w.root);
    expect(command?.args).toEqual(
      expect.arrayContaining([
        path.join(versionDir(w.root, '1.0.0'), 'dist', 'launcher.js'),
        `--install-root=${w.root}`,
        '--apply-update=1.0.1',
        '--wait-pid=100',
        '--port=4711',
      ]),
    );
    expect(command?.args).not.toContain('--restore');
    expect(w.children[0]?.unref).toHaveBeenCalledOnce();
    expect(w.restarts).not.toHaveBeenCalled();
    await nextMacrotask();
    expect(w.restarts).toHaveBeenCalledOnce();
    expect(await commandError(service.handle(check, ctx))).toEqual(
      makeError('UPDATE_BUSY', { status: 'restarting' }),
    );
  });

  it('reports a failed check in error and keeps the status', async () => {
    const w = await world();
    w.server.set(w.endpoints.latestUrl, 'down', { status: 503 });
    const service = await w.create();
    expect(await commandError(service.handle(check, ctx))).toEqual(
      makeError('UPDATE_CHECK_FAILED', { reason: 'http', status: 503 }),
    );
    expect(service.state()).toMatchObject({
      status: 'idle',
      error: makeError('UPDATE_CHECK_FAILED', { reason: 'http', status: 503 }),
    });
    expect(await service.handle({ name: 'update.dismiss', what: 'error' }, ctx)).toEqual({});
    expect(service.state().error).toBeNull();
  });

  it('a failed preparation goes back to available with the error', async () => {
    const w = await world();
    const bytes = await w.zip('1.0.1');
    serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: bytes,
      latest: { sha256: '0'.repeat(64) },
    });
    const service = await w.create();
    await service.handle(check, ctx);
    await service.handle(prepare('1.0.1'), ctx);
    await until(() => service.state().error !== null, 'error');
    expect(service.state()).toMatchObject({
      status: 'available',
      progress: null,
      error: makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'hash' }),
    });
    expect(await commandError(service.handle(prepare('1.0.2'), ctx))).toEqual(
      makeError('VALIDATION_FAILED', { reason: 'version' }),
    );
  });

  it('dismisses the offer persistently', async () => {
    const w = await world();
    serveRelease(w.server, w.endpoints, w.key, { version: '1.0.1', zip: Buffer.from('zip') });
    const service = await w.create();
    await service.handle(check, ctx);
    expect(await service.handle({ name: 'update.dismiss', what: 'available' }, ctx)).toEqual({});
    expect(service.state()).toMatchObject({ status: 'available', dismissedVersion: '1.0.1' });
    expect((await w.create()).state().dismissedVersion).toBe('1.0.1');
  });

  it('sends progress at most twice a second, status changes at once', async () => {
    const w = await world();
    const bytes = await w.zip('1.0.1');
    const { latest } = serveRelease(w.server, w.endpoints, w.key, { version: '1.0.1', zip: bytes });
    let push: ((chunk: Uint8Array) => void) | null = null;
    w.server.routes.set(
      latest.url,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (chunk) => {
                controller.enqueue(chunk);
              };
            },
          }),
        ),
    );
    const service = await w.create();
    await service.handle(check, ctx);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen: { status: string; progress: number | null }[] = [];
    service.onChange(() => seen.push({ status: statusOf(service), progress: service.state().progress }));
    await service.handle(prepare('1.0.1'), ctx);
    await until(() => push !== null, 'download');
    expect(seen).toEqual([{ status: 'downloading', progress: 0 }]);
    const send = (from: number, to: number) => push?.(new Uint8Array(bytes.subarray(from, to)));
    send(0, 100);
    await until(() => (service.state().progress ?? 0) > 0, 'progress');
    const first = service.state().progress ?? 0;
    send(100, 200);
    await until(() => (service.state().progress ?? 0) > first, 'more progress');
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PROGRESS_THROTTLE_MS);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.status).toBe('downloading');
    expect(seen[1]?.progress).toBe(service.state().progress);
    await service.close();
  });

  it('close() aborts a download, removes the partial file and stops notifying', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    let started = false;
    w.server.routes.set(
      latest.url,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64));
              started = true;
            },
          }),
        ),
    );
    const service = await w.create();
    await service.handle(check, ctx);
    await service.handle(prepare('1.0.1'), ctx);
    await until(() => started && service.state().progress !== 0, 'download');
    const listener = vi.fn();
    service.onChange(listener);
    await service.close();
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(await commandError(service.handle(check, ctx))).toEqual(
      makeError('UPDATE_BUSY', { status: 'restarting' }),
    );
  });
});

describe('apply: the handshake', () => {
  async function readyWorld(handshake: string | null, patch: UpdateServiceSeams = {}) {
    const w = await world({ handshake });
    serveRelease(w.server, w.endpoints, w.key, { version: '1.0.1', zip: await w.zip('1.0.1') });
    const service = await w.create(patch);
    await service.handle(check, ctx);
    await service.handle(prepare('1.0.1'), ctx);
    await until(() => statusOf(service) === 'ready', 'ready');
    return { w, service };
  }

  it('FAILED <reason>: UPDATE_RESTART_FAILED with that reason, the server stays ready', async () => {
    const { w, service } = await readyWorld('PARALLAX-APPLY-FAILED lock\n');
    const expected = makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'lock' });
    expect(await commandError(service.handle(apply('1.0.1'), ctx))).toEqual(expected);
    expect(service.state()).toMatchObject({ status: 'ready', error: expected });
    expect(w.killed).toEqual([]);
    expect(service.orchestratorPid()).toBeNull();
    expect(w.restarts).not.toHaveBeenCalled();
  });

  it('no line within handshakeMs: the orchestrator is ended, then reason handshake', async () => {
    const { w, service } = await readyWorld(null);
    const expected = makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'handshake' });
    expect(await commandError(service.handle(apply('1.0.1'), ctx))).toEqual(expected);
    expect(w.killed).toEqual([4242]);
    expect(service.state()).toMatchObject({ status: 'ready', error: expected });
    // a READY after giving up changes nothing
    w.children[0]?.stdout.write('PARALLAX-APPLY-READY\n');
    await nextMacrotask();
    expect(statusOf(service)).toBe('ready');
    expect(w.restarts).not.toHaveBeenCalled();
  });

  it('an unreadable line: ended at once, reason handshake', async () => {
    const { w, service } = await readyWorld('Error: something went wrong\n');
    expect(await commandError(service.handle(apply('1.0.1'), ctx))).toEqual(
      makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'handshake' }),
    );
    expect(w.killed).toEqual([4242]);
  });

  it('waits APPLY_TIMEOUTS.handshakeMs by default before ending the orchestrator', async () => {
    const { w, service } = await readyWorld(null, { handshakeMs: undefined });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = commandError(service.handle(apply('1.0.1'), ctx));
    await until(() => w.spawned.length === 1, 'spawn');
    await vi.advanceTimersByTimeAsync(APPLY_TIMEOUTS.handshakeMs - 1);
    expect(w.killed).toEqual([]);
    expect(statusOf(service)).toBe('ready');
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(
      makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'handshake' }),
    );
    expect(w.killed).toEqual([4242]);
  });

  it('a broken version folder: reason package, nothing spawned', async () => {
    const { w, service } = await readyWorld('PARALLAX-APPLY-READY\n');
    await writeFile(path.join(versionDir(w.root, '1.0.1'), 'release.json'), '{}');
    expect(await commandError(service.handle(apply('1.0.1'), ctx))).toEqual(
      makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'package' }),
    );
    expect(w.spawned).toHaveLength(0);
  });
});

describe('Install from file', () => {
  it('stages a newer package (source file) and applies it', async () => {
    const w = await world();
    const service = await w.create();
    expect(service.uploadIssue()).toBeNull();
    const file = await w.upload(
      await w.zip('1.1.0', { files: { 'CHANGELOG.md': '## [1.1.0] – 2026-12-10\n\n- Eleven.\n' } }),
      service,
    );
    expect(path.dirname(file)).toBe(path.join(w.root, DOWNLOADS_DIR));
    service.acceptPackage(file);
    expect(service.uploadIssue()).toMatchObject({ code: 'UPDATE_BUSY' });
    await until(() => statusOf(service) === 'ready', 'ready');
    expect(service.state().available).toEqual({
      version: '1.1.0',
      source: 'file',
      size: null,
      createdAt: '2026-11-17T09:00:00.000Z',
      downgrade: false,
      needsRestore: false,
      backupAt: null,
    });
    expect(await exists(file)).toBe(false);
    expect((await service.changelog({ for: 'available' })).sections.map((s) => s.version)).toEqual(['1.1.0']);
    expect(await service.handle(apply('1.1.0'), ctx)).toEqual({});
    expect(w.spawned[0]?.args).toContain('--apply-update=1.1.0');
  });

  it('blocks a downgrade with other schemas without backup; with backup it needs acceptDataLoss', async () => {
    const w = await world({ own: { schemas: OTHER_SCHEMAS } });
    const service = await w.create();
    service.acceptPackage(await w.upload(await w.zip('0.9.0'), service));
    await until(() => service.state().error !== null, 'refusal');
    expect(service.state()).toMatchObject({
      status: 'idle',
      available: null,
      error: makeError('UPDATE_DOWNGRADE_BLOCKED', { version: '0.9.0' }),
    });

    const at = new Date('2026-11-20T08:00:00.000Z');
    await createBackup(w.home, { from: testBuildId('0.9.0'), to: w.own.buildId, now: at });
    service.acceptPackage(await w.upload(await w.zip('0.9.0'), service));
    await until(() => statusOf(service) === 'ready', 'ready');
    expect(service.state().available).toMatchObject({
      version: '0.9.0',
      downgrade: true,
      needsRestore: true,
      backupAt: at.toISOString(),
    });
    expect(await commandError(service.handle(apply('0.9.0'), ctx))).toEqual(
      makeError('VALIDATION_FAILED', { reason: 'data_loss_not_accepted' }),
    );
    expect(await service.handle(apply('0.9.0', true), ctx)).toEqual({});
    expect(w.spawned[0]?.args).toEqual(expect.arrayContaining(['--apply-update=0.9.0', '--restore']));
  });

  it('fetches the SDK from the registry of the settings', async () => {
    const registry = 'https://nexus.example.com/repository/npm-all/';
    const w = await world({ settings: sampleSettings({ updates: { check: true, registry } }) });
    const service = await w.create();
    service.acceptPackage(await w.upload(await w.zip('1.1.0'), service));
    await until(() => statusOf(service) === 'ready', 'ready');
    expect(w.sdk[0]?.registry).toBe(registry);
  });

  it('refuses a package while busy and deletes it', async () => {
    const w = await world();
    const service = await w.create();
    service.acceptPackage(await w.upload(await w.zip('1.1.0'), service));
    const second = await w.upload(Buffer.from('second'), service);
    service.acceptPackage(second);
    await until(() => !(service.state().error === null), 'busy error');
    expect(service.state().error).toMatchObject({ code: 'UPDATE_BUSY' });
    await until(() => statusOf(service) === 'ready', 'ready');
    await until(() => w.sdk.length === 1, 'sdk');
    expect(await exists(second)).toBe(false);
  });
});

describe('rollback', () => {
  it('switches back to the previous version without restore', async () => {
    const w = await world({ previous: '0.9.0' });
    const service = await w.create();
    expect(await commandError(service.handle(rollback('0.8.0'), ctx))).toEqual(
      makeError('VALIDATION_FAILED', { reason: 'version' }),
    );
    expect(await service.handle(rollback('0.9.0'), ctx)).toEqual({});
    expect(statusOf(service)).toBe('restarting');
    expect(w.spawned[0]?.args).toContain('--apply-update=0.9.0');
    expect(w.spawned[0]?.args).not.toContain('--restore');
  });

  it('with other schemas: blocked without backup, needs acceptDataLoss with it', async () => {
    const w = await world({ previous: '0.9.0', own: { schemas: OTHER_SCHEMAS } });
    const service = await w.create();
    expect(service.state().previous).toEqual({ version: '0.9.0', needsRestore: true, backupAt: null });
    expect(await commandError(service.handle(rollback('0.9.0', true), ctx))).toEqual(
      makeError('UPDATE_DOWNGRADE_BLOCKED', { version: '0.9.0' }),
    );
    const at = new Date('2026-11-20T08:00:00.000Z');
    await createBackup(w.home, { from: testBuildId('0.9.0'), to: w.own.buildId, now: at });
    expect(await commandError(service.handle(rollback('0.9.0'), ctx))).toEqual(
      makeError('VALIDATION_FAILED', { reason: 'data_loss_not_accepted' }),
    );
    expect(service.state().previous?.backupAt).toBe(at.toISOString());
    expect(await service.handle(rollback('0.9.0', true), ctx)).toEqual({});
    expect(w.spawned[0]?.args).toEqual(expect.arrayContaining(['--apply-update=0.9.0', '--restore']));
  });
});

describe('schedule', () => {
  it('checks 60 s after start, then every 12 h; follows updates.check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await world();
    const service = await w.create();
    const checks = () => w.server.count(w.endpoints.latestUrl);
    service.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(checks()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => checks() === 1 && statusOf(service) === 'idle', 'first check');
    expect(service.state().checkedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await until(() => checks() === 2 && statusOf(service) === 'idle', 'second check');

    const off = sampleSettings({ updates: { check: false, registry: null } });
    service.settingsChanged(off);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(checks()).toBe(2);
    service.settingsChanged(sampleSettings());
    await vi.advanceTimersByTimeAsync(RECHECK_SOON_MS);
    await until(() => checks() === 3, 'check after switching on');
  });

  it('an automatic failure lands only in error; a prepared update is not checked again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await world();
    w.server.set(w.endpoints.latestUrl, 'down', { status: 500 });
    const service = await w.create();
    service.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    await until(() => service.state().error !== null, 'error');
    expect(service.state()).toMatchObject({ status: 'idle', error: { code: 'UPDATE_CHECK_FAILED' } });

    service.acceptPackage(await w.upload(await w.zip('1.1.0'), service));
    await until(() => statusOf(service) === 'ready', 'ready');
    const before = w.server.count(w.endpoints.latestUrl);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await nextMacrotask();
    expect(w.server.count(w.endpoints.latestUrl)).toBe(before);
    expect(statusOf(service)).toBe('ready');
  });

  it('without updates.check no automatic check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await world({ settings: sampleSettings({ updates: { check: false, registry: null } }) });
    const service = await w.create();
    service.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(w.server.calls).toHaveLength(0);
  });
});
