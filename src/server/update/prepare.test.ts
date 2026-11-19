import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { SdkRequest } from '../install/install';
import {
  DOWNLOADS_DIR,
  InstallError,
  VERSIONS_DIR,
  assertNotRealUserFolder,
  versionDir,
  writeCurrent,
} from '../install/layout';
import { SdkError } from '../install/sdk';
import {
  fakeProvideSdk,
  makeTestKey,
  makeTestPackage,
  testBuildId,
  type TestPackageOptions,
} from '../install/testPackage';
import { logger } from '../lib/logger';
import { runFile } from '../lib/process';
import type { ReleaseInfo } from '../launcher/release';
import { createBackup } from '../store/backup';
import { CommandError } from '../sync/ports';
import { FetchError } from './fetch';
import {
  prepareErrorPayload,
  preparePackage,
  prepareRelease,
  type PrepareEnv,
  type PreparePhase,
  type PrepareRun,
} from './prepare';
import {
  FakeReleaseServer,
  hangingResponse,
  serveRelease,
  testUpdateEndpoints,
  zipFolders,
} from './testRelease';
import { ZipError } from './zip';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-prepare-'));
  temps.push(dir);
  return dir;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

const OTHER_SCHEMAS = { 'settings.json': 'c'.repeat(64) };

async function world() {
  const base = await temp();
  const root = path.join(base, 'Programs', 'Parallax');
  assertNotRealUserFolder(root);
  const home = path.join(base, 'home');
  const key = makeTestKey();
  const endpoints = testUpdateEndpoints([key.x]);
  const server = new FakeReleaseServer();
  const sdk: SdkRequest[] = [];
  const own = await makeTestPackage(versionDir(root, '1.0.0'), { version: '1.0.0', key });
  await writeCurrent(root, { schemaVersion: 1, version: '1.0.0', previous: null });
  let builds = 0;
  const zip = async (
    version: string,
    options: Partial<TestPackageOptions> = {},
    extra?: Record<string, string>,
  ) => {
    const parent = path.join(base, 'build', String(builds++));
    const dir = path.join(parent, `parallax-${version}`);
    await makeTestPackage(dir, { version, key, ...options });
    for (const [rel, content] of Object.entries(extra ?? {})) await writeFile(path.join(dir, rel), content);
    return zipFolders(parent, [`parallax-${version}`], path.join(parent, `parallax-${version}-win.zip`));
  };
  const env = (patch: Partial<PrepareEnv> = {}): PrepareEnv => ({
    root,
    home,
    keys: [key.x],
    registry: undefined,
    fetch: server.fetch,
    allowLoopbackHttp: true,
    run: runFile,
    provideSdk: fakeProvideSdk(sdk),
    lockRoot: () => Promise.resolve({ release: () => Promise.resolve() }),
    nodeVersion: '26.12.0',
    now: () => new Date(),
    log: logger.child({ test: 'prepare' }),
    own,
    ...patch,
  });
  const progress: [PreparePhase, number][] = [];
  const run = (signal: AbortSignal = new AbortController().signal): PrepareRun => ({
    signal,
    onProgress: (phase, fraction) => progress.push([phase, fraction]),
  });
  /** An uploaded zip below downloads (like the upload route writes it). */
  const upload = async (bytes: Buffer) => {
    const file = path.join(root, DOWNLOADS_DIR, `upload-test-${String(builds++)}.zip`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return file;
  };
  return { base, root, home, key, endpoints, server, sdk, own, zip, env, run, progress, upload };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

async function payload(promise: Promise<unknown>) {
  return prepareErrorPayload(await rejection(promise), '26.12.0');
}

describe('prepareRelease', () => {
  it('downloads, checks, unpacks and stages a release; leaves nothing in downloads', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    const result = await prepareRelease(w.env(), latest, w.run());
    expect(result.release.version).toBe('1.0.1');
    expect(result.reused).toBe(false);
    expect(await exists(path.join(versionDir(w.root, '1.0.1'), 'release.json'))).toBe(true);
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
    expect(w.sdk).toHaveLength(1);
    const phases = w.progress.map(([phase]) => phase);
    expect(phases[0]).toBe('downloading');
    expect(phases.at(-1)).toBe('preparing');
    expect(w.progress.at(-1)?.[1]).toBe(1);
    const fractions = w.progress.filter(([phase]) => phase === 'preparing').map(([, f]) => f);
    expect(fractions.every((f, i) => i === 0 || f >= (fractions[i - 1] ?? 0) - 0.26)).toBe(true);
  });

  it('keeps an intact version folder of an earlier run without downloading again', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    await prepareRelease(w.env(), latest, w.run());
    const again = await prepareRelease(w.env(), latest, w.run());
    expect(again.reused).toBe(true);
    expect(w.server.count(w.endpoints.assetUrl('1.0.1'))).toBe(1);
  });

  it('removes older prepared versions, keeps current, previous and the running one', async () => {
    const w = await world();
    await makeTestPackage(versionDir(w.root, '0.9.0'), { version: '0.9.0', key: w.key });
    await makeTestPackage(versionDir(w.root, '1.0.1'), { version: '1.0.1', key: w.key });
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.2',
      zip: await w.zip('1.0.2'),
    });
    await prepareRelease(w.env(), latest, w.run());
    const left = (await readdir(path.join(w.root, VERSIONS_DIR))).filter((name) => !name.startsWith('.'));
    expect(left.sort()).toEqual(['1.0.0', '1.0.2']);
  });

  it('refuses a wrong size or hash of the zip', async () => {
    const w = await world();
    const bytes = await w.zip('1.0.1');
    const size = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: bytes,
      latest: { size: bytes.length + 10 },
    });
    expect(await payload(prepareRelease(w.env(), size.latest, w.run()))).toEqual(
      makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'size' }),
    );
    const small = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: bytes,
      latest: { size: bytes.length - 10 },
    });
    expect((await payload(prepareRelease(w.env(), small.latest, w.run()))).params).toEqual({
      reason: 'size',
    });
    const hash = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: bytes,
      latest: { sha256: '0'.repeat(64) },
    });
    expect((await payload(prepareRelease(w.env(), hash.latest, w.run()))).params).toEqual({ reason: 'hash' });
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
    expect(await exists(versionDir(w.root, '1.0.1'))).toBe(false);
  });

  it('refuses a foreign file, a foreign signature and a too new Node', async () => {
    const w = await world();
    const foreign = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1', {}, { 'evil.js': 'boom' }),
    });
    expect(await payload(prepareRelease(w.env(), foreign.latest, w.run()))).toEqual(
      makeError('UPDATE_INVALID_PACKAGE', { reason: 'files' }),
    );
    const signed = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1', { key: makeTestKey() }),
    });
    expect(await payload(prepareRelease(w.env(), signed.latest, w.run()))).toEqual(
      makeError('UPDATE_INVALID_SIGNATURE', { file: 'release.json' }),
    );
    const node = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1', { minNode: '99.0.0' }),
    });
    expect(await payload(prepareRelease(w.env(), node.latest, w.run()))).toEqual(
      makeError('UPDATE_NODE_TOO_OLD', { required: '99.0.0', actual: '26.12.0' }),
    );
    expect(w.sdk).toHaveLength(0);
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
  });

  it('refuses a release for a newer Node from latest.json before the lock and the download (ADR-232)', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
      latest: { minNode: '27.0.0' },
    });
    let locked = false;
    const lockRoot = () => {
      locked = true;
      return Promise.resolve({ release: () => Promise.resolve() });
    };
    expect(await payload(prepareRelease(w.env({ lockRoot }), latest, w.run()))).toEqual(
      makeError('UPDATE_NODE_TOO_OLD', { required: '27.0.0', actual: '26.12.0' }),
    );
    expect(locked).toBe(false);
    expect(w.server.count(latest.url)).toBe(0);
    expect(w.progress).toEqual([]);
    // Without minNode (a latest.json written before 1.0.2) the release.json check still applies.
    const older = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
      latest: { minNode: null },
    });
    expect((await prepareRelease(w.env(), older.latest, w.run())).release.version).toBe('1.0.1');
  });

  it('maps a failed SDK step (wrong hash) to UPDATE_SDK_FAILED', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    const provideSdk = () => Promise.reject(new SdkError('the SHA-512 of the tarball does not match'));
    expect(await payload(prepareRelease(w.env({ provideSdk }), latest, w.run()))).toEqual(
      makeError('UPDATE_SDK_FAILED'),
    );
    expect(await exists(versionDir(w.root, '1.0.1'))).toBe(false);
  });

  it('answers UPDATE_BUSY while another process holds the install lock', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    const lockRoot = () => Promise.resolve(null);
    expect(await payload(prepareRelease(w.env({ lockRoot }), latest, w.run()))).toEqual(
      makeError('UPDATE_BUSY', { status: 'locked' }),
    );
    expect(w.server.calls).toHaveLength(0);
  });

  it('stops a download on abort and removes the partial file', async () => {
    const w = await world();
    const { latest } = serveRelease(w.server, w.endpoints, w.key, {
      version: '1.0.1',
      zip: await w.zip('1.0.1'),
    });
    let released = false;
    w.server.routes.set(
      w.endpoints.assetUrl('1.0.1'),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(100));
            },
          }),
        ),
    );
    const controller = new AbortController();
    const pending = rejection(
      prepareRelease(
        w.env({
          lockRoot: () => Promise.resolve({ release: () => Promise.resolve(void (released = true)) }),
        }),
        latest,
        {
          signal: controller.signal,
          onProgress: (phase, fraction) => {
            if (phase === 'downloading' && fraction > 0) controller.abort();
          },
        },
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(FetchError);
    expect(controller.signal.aborted).toBe(true);
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
    expect(released).toBe(true);
    w.server.routes.set(w.endpoints.assetUrl('1.0.1'), hangingResponse);
  });
});

describe('preparePackage (Install from file)', () => {
  it('stages a newer package and removes the upload', async () => {
    const w = await world();
    const file = await w.upload(await w.zip('1.1.0'));
    const result = await preparePackage(w.env(), file, w.run());
    expect(result).toMatchObject({ downgrade: false, needsRestore: false, backupAt: null, reused: false });
    expect(result.release.version).toBe('1.1.0');
    expect(await exists(file)).toBe(false);
    expect(await readdir(path.join(w.root, DOWNLOADS_DIR))).toEqual([]);
  });

  it('refuses the running version and a zip that is no package', async () => {
    const w = await world();
    expect(await payload(preparePackage(w.env(), await w.upload(await w.zip('1.0.0')), w.run()))).toEqual(
      makeError('UPDATE_INVALID_PACKAGE', { reason: 'same_version' }),
    );
    const junk = await w.upload(Buffer.from('no zip at all'));
    expect(await payload(preparePackage(w.env(), junk, w.run()))).toEqual(
      makeError('UPDATE_INVALID_PACKAGE', { reason: 'zip' }),
    );
    expect(await exists(junk)).toBe(false);
  });

  it('takes an older package with equal schemas as a plain downgrade', async () => {
    const w = await world();
    const result = await preparePackage(w.env(), await w.upload(await w.zip('0.9.0')), w.run());
    expect(result).toMatchObject({ downgrade: true, needsRestore: false, backupAt: null });
  });

  it('blocks an older package with other schemas unless the backup of that change exists', async () => {
    const w = await world();
    const own: ReleaseInfo = { ...w.own, schemas: OTHER_SCHEMAS };
    expect(
      await payload(preparePackage(w.env({ own }), await w.upload(await w.zip('0.9.0')), w.run())),
    ).toEqual(makeError('UPDATE_DOWNGRADE_BLOCKED', { version: '0.9.0' }));
    expect(await exists(versionDir(w.root, '0.9.0'))).toBe(false);
    const at = new Date('2026-11-20T08:00:00.000Z');
    await createBackup(w.home, { from: testBuildId('0.9.0'), to: own.buildId, now: at });
    const result = await preparePackage(w.env({ own }), await w.upload(await w.zip('0.9.0')), w.run());
    expect(result).toMatchObject({ downgrade: true, needsRestore: true, backupAt: at.toISOString() });
  });
});

describe('prepareErrorPayload', () => {
  it('maps every failure to an update code', () => {
    const map = (error: unknown) => prepareErrorPayload(error, '24.0.0');
    expect(map(new CommandError(makeError('UPDATE_BUSY', { status: 'x' })))).toEqual(
      makeError('UPDATE_BUSY', { status: 'x' }),
    );
    expect(map(new ZipError('too_large', 'big'))).toEqual(
      makeError('UPDATE_INVALID_PACKAGE', { reason: 'too_large' }),
    );
    expect(map(new FetchError('http', 'HTTP 503', { status: 503 }))).toEqual(
      makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'http', status: 503 }),
    );
    expect(map(new FetchError('url', 'refused'))).toEqual(
      makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'network' }),
    );
    expect(map(new InstallError('sig', { reason: 'signature' })).code).toBe('UPDATE_INVALID_SIGNATURE');
    expect(map(new InstallError('node', { reason: 'node' }))).toEqual(
      makeError('UPDATE_NODE_TOO_OLD', { required: null, actual: '24.0.0' }),
    );
    expect(map(new InstallError('files', { reason: 'files' })).params).toEqual({ reason: 'files' });
    expect(map(new InstallError('sdk', { reason: 'sdk' })).code).toBe('UPDATE_SDK_FAILED');
    expect(map(new InstallError('busy', { reason: 'in_use' }))).toEqual(
      makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'disk' }),
    );
    expect(map(new Error('EPERM'))).toEqual(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'disk' }));
  });
});
