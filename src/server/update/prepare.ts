/**
 * Preparing an update in the background (WP-87 §2.1 "Vorbereiten", "Aus Datei"; docs/wp/WP-83.md
 * §9.2, §9.6). Everything runs under the `install` lock of the installation root – the same lock
 * as install.cmd and the orchestrator – and with the code and the release keys of the RUNNING
 * version; nothing of the new package runs before it is checked.
 *
 * Release (`prepareRelease`, source `github`):
 * 1. lock (busy → UPDATE_BUSY {status: 'locked'}); an intact `versions\<v>` of an earlier run is
 *    kept at once (`reused`, no download);
 * 2. download to `downloads\parallax-<v>-win.zip.partial`, size and SHA-256 against latest.json,
 *    rename;
 * 3. list the zip (zip.ts: entries, size, one root `parallax-<v>/`);
 * 4. unpack into a fresh `downloads\unpack-<v>-<stamp>-<id>\`;
 * 5. release.json: signature (running keys), version = latest.json, `minNode`; then `stageVersion`
 *    (files, copy of exactly the listed content, the SDK, `versions\<v>`);
 * 6. zip and unpack folder removed (always), `cleanupVersions` keeps current/previous/running/new;
 * 7. ready.
 * Package (`preparePackage`, "Install from file"): steps 3–6 for an uploaded zip; the same version
 * as the running one is refused, an older one is a downgrade (previous.ts rules; other store
 * schemas without the matching backup → UPDATE_DOWNGRADE_BLOCKED, before anything is staged).
 *
 * Failures map to the update codes in `prepareErrorPayload`; an abort (shutdown) throws the
 * signal's reason – the partial files are removed either way.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { makeError, type ErrorPayload } from '@shared/errors';
import { compareVersions } from '@shared/version';
import {
  checkNodeVersion,
  installErrorReason,
  readSignedRelease,
  stageVersion,
  verifyVersion,
  type SdkRequest,
  type StageStep,
} from '../install/install';
import { DOWNLOADS_DIR, assertNotRealUserFolder, readCurrent, versionDir } from '../install/layout';
import { cleanupVersions, folderStamp } from '../install/versions';
import { withFsRetry } from '../lib/fs';
import type { RunFileFn } from '../lib/process';
import { RELEASE_FILE, type ReleaseInfo } from '../launcher/release';
import { CommandError } from '../sync/ports';
import { releaseZipName } from './endpoints';
import { FetchError, downloadFile } from './fetch';
import type { LatestInfo } from './latest';
import { downgradeOf } from './previous';
import { ZipError, extractZip, listZip } from './zip';

/** `downloads\unpack-<v>-<stamp>-<id>`: an unpacked zip. */
export const UNPACK_PREFIX = 'unpack-';
/** `downloads\upload-<stamp>-<id>.zip`: an uploaded zip ("Install from file"). */
export const UPLOAD_PREFIX = 'upload-';
/** Leftover uploads older than this belong to no running request any more. */
const STALE_UPLOAD_MS = 60 * 60_000;
const RELEASE_ZIP = /^parallax-.+-win\.zip(?:\.partial)?$/u;

/** Progress of the preparing phase: unpacking, then the steps of `stageVersion`. */
const PHASES: Readonly<Record<'unpack' | StageStep, readonly [number, number]>> = {
  unpack: [0, 0.15],
  check: [0.15, 0.4],
  copy: [0.4, 0.9],
  sdk: [0.9, 1],
};

export interface RootLock {
  release(): Promise<void>;
}

export interface PrepareEnv {
  root: string;
  home: string;
  /** Release keys of the running version (endpoints.ts). */
  keys: readonly string[];
  /** npm registry for the Agent SDK; undefined = npm configuration. */
  registry: string | undefined;
  fetch: typeof fetch;
  allowLoopbackHttp: boolean;
  /** tar.exe */
  run: RunFileFn;
  provideSdk: (request: SdkRequest) => Promise<string>;
  /** The `install` lock of the root; null = held by another process. */
  lockRoot: (root: string) => Promise<RootLock | null>;
  nodeVersion: string;
  now: () => Date;
  log: Logger;
  /** release.json of the running version. */
  own: ReleaseInfo;
}

export type PreparePhase = 'downloading' | 'preparing';

export interface PrepareRun {
  signal: AbortSignal;
  /** `fraction` 0…1 within the phase (raw, per chunk or file: the caller throttles). */
  onProgress: (phase: PreparePhase, fraction: number) => void;
}

export interface PreparedVersion {
  release: ReleaseInfo;
  /** `versions\<v>` was intact already. */
  reused: boolean;
}

export interface PreparedPackage extends PreparedVersion {
  downgrade: boolean;
  needsRestore: boolean;
  backupAt: string | null;
}

function fail(error: ErrorPayload): never {
  throw new CommandError(error);
}

async function removeQuietly(target: string, log: Logger): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    log.warn({ err: error, target }, 'could not remove an update download');
  }
}

async function withRootLock<T>(env: PrepareEnv, work: () => Promise<T>): Promise<T> {
  assertNotRealUserFolder(env.root);
  const lock = await env.lockRoot(env.root);
  if (lock === null) fail(makeError('UPDATE_BUSY', { status: 'locked' }));
  try {
    return await work();
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/**
 * Leftovers of an earlier run below `downloads` (the lock is held, so no installer is using it):
 * unpack folders, release zips, uploads older than an hour – never `keep` (the upload at hand).
 */
async function cleanDownloads(env: PrepareEnv, downloads: string, keep: string | null): Promise<void> {
  let names: string[];
  try {
    names = await readdir(downloads);
  } catch {
    return;
  }
  const keepName = keep === null ? null : path.basename(keep).toLowerCase();
  for (const name of names) {
    if (name.toLowerCase() === keepName) continue;
    const full = path.join(downloads, name);
    if (name.startsWith(UNPACK_PREFIX) || RELEASE_ZIP.test(name)) {
      await removeQuietly(full, env.log);
    } else if (name.startsWith(UPLOAD_PREFIX)) {
      const info = await stat(full).catch(() => null);
      if (info !== null && env.now().getTime() - info.mtimeMs > STALE_UPLOAD_MS) {
        await removeQuietly(full, env.log);
      }
    }
  }
}

/** Throws UPDATE_NODE_TOO_OLD unless this Node is at least `release.minNode`. */
function assertNode(env: PrepareEnv, release: ReleaseInfo): void {
  try {
    checkNodeVersion(release, env.nodeVersion);
  } catch {
    fail(makeError('UPDATE_NODE_TOO_OLD', { required: release.minNode, actual: env.nodeVersion }));
  }
}

/** release.json of the unpacked package: signature (running keys), version, Node. */
async function checkPackage(env: PrepareEnv, packageDir: string, version: string): Promise<ReleaseInfo> {
  const { release } = await readSignedRelease(packageDir, env.keys);
  if (release.version !== version || path.basename(packageDir) !== `parallax-${release.version}`) {
    fail(makeError('UPDATE_INVALID_PACKAGE', { reason: 'version' }));
  }
  assertNode(env, release);
  return release;
}

interface Unpacked {
  /** The fresh folder (removed by the caller). */
  dir: string;
  /** `<dir>\parallax-<v>` */
  packageDir: string;
  version: string;
}

/** Steps 3–4: list (`version` null = from the zip), then unpack into a fresh folder. */
async function unpack(
  env: PrepareEnv,
  zip: string,
  version: string | null,
  run: PrepareRun,
): Promise<Unpacked> {
  const downloads = path.dirname(zip);
  run.onProgress('preparing', PHASES.unpack[0]);
  const listing = await listZip(zip, version, { run: env.run, signal: run.signal, cwd: downloads });
  if (listing.version === env.own.version)
    fail(makeError('UPDATE_INVALID_PACKAGE', { reason: 'same_version' }));
  const id = randomUUID().slice(0, 8);
  const dir = path.join(downloads, `${UNPACK_PREFIX}${listing.version}-${folderStamp(env.now())}-${id}`);
  await mkdir(dir);
  try {
    await extractZip(zip, dir, { run: env.run, signal: run.signal });
  } catch (error) {
    await removeQuietly(dir, env.log);
    throw error;
  }
  run.onProgress('preparing', PHASES.unpack[1]);
  return { dir, packageDir: path.join(dir, listing.rootDir), version: listing.version };
}

/** Step 5: `stageVersion` with the running keys; progress mapped into the preparing phase. */
async function stage(env: PrepareEnv, packageDir: string, run: PrepareRun): Promise<PreparedVersion> {
  const result = await stageVersion(
    {
      packageDir,
      root: env.root,
      keys: env.keys,
      nodeVersion: env.nodeVersion,
      signal: run.signal,
      ...(env.registry === undefined ? {} : { registry: env.registry }),
      onProgress: (step, done, total) => {
        const [from, to] = PHASES[step];
        run.onProgress('preparing', from + (to - from) * (total > 0 ? Math.min(1, done / total) : 1));
      },
    },
    {
      provideSdk: env.provideSdk,
      log: (line) => {
        env.log.info({ step: 'stage' }, line);
      },
      now: env.now,
    },
  );
  return { release: result.release, reused: result.reused };
}

/** Step 6: older prepared versions go; current, previous, the running and the new one stay. */
async function cleanup(env: PrepareEnv, version: string): Promise<void> {
  const current = await readCurrent(env.root).catch(() => null);
  const result = await cleanupVersions(
    env.root,
    [current?.version ?? null, current?.previous ?? null, env.own.version, version],
    env.now(),
  );
  if (result.removed.length > 0) env.log.info({ removed: result.removed }, 'older prepared versions removed');
  if (result.problems.length > 0) env.log.warn({ problems: result.problems }, 'version cleanup incomplete');
}

/** An intact `versions\<v>` (full check: signature, files, SDK) – or null. */
async function intactVersion(
  env: PrepareEnv,
  version: string,
  run: PrepareRun,
): Promise<PreparedVersion | null> {
  const there = await stat(path.join(versionDir(env.root, version), RELEASE_FILE)).catch(() => null);
  if (there === null) return null;
  run.onProgress('preparing', PHASES.check[0]);
  let release: ReleaseInfo;
  try {
    release = await verifyVersion(env.root, version, env.keys);
  } catch (error) {
    env.log.info({ err: error, version }, 'prepared version folder is not intact - downloading again');
    return null;
  }
  run.signal.throwIfAborted();
  assertNode(env, release);
  return { release, reused: true };
}

/** Steps 1–7 for the release of latest.json. */
export async function prepareRelease(
  env: PrepareEnv,
  latest: LatestInfo,
  run: PrepareRun,
): Promise<PreparedVersion> {
  return withRootLock(env, async () => {
    const downloads = path.join(env.root, DOWNLOADS_DIR);
    await mkdir(downloads, { recursive: true });
    await cleanDownloads(env, downloads, null);
    const kept = await intactVersion(env, latest.version, run);
    if (kept !== null) {
      await cleanup(env, latest.version);
      return kept;
    }
    const zip = path.join(downloads, releaseZipName(latest.version));
    const partial = `${zip}.partial`;
    let unpacked: Unpacked | null = null;
    try {
      run.onProgress('downloading', 0);
      const result = await downloadFile(latest.url, partial, {
        fetch: env.fetch,
        allowLoopbackHttp: env.allowLoopbackHttp,
        signal: run.signal,
        maxBytes: latest.size,
        expected: latest.size,
        onProgress: (done) => {
          run.onProgress('downloading', Math.min(1, done / latest.size));
        },
      });
      if (result.bytes !== latest.size) fail(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'size' }));
      if (result.sha256 !== latest.sha256) fail(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'hash' }));
      await withFsRetry(() => rename(partial, zip));
      unpacked = await unpack(env, zip, latest.version, run);
      await checkPackage(env, unpacked.packageDir, latest.version);
      const staged = await stage(env, unpacked.packageDir, run);
      await cleanup(env, latest.version);
      return staged;
    } finally {
      await removeQuietly(partial, env.log);
      await removeQuietly(zip, env.log);
      if (unpacked !== null) await removeQuietly(unpacked.dir, env.log);
    }
  });
}

/** Steps 3–6 for an uploaded zip (removed afterwards in any case). */
export async function preparePackage(
  env: PrepareEnv,
  zip: string,
  run: PrepareRun,
): Promise<PreparedPackage> {
  try {
    return await withRootLock(env, async () => {
      const downloads = path.join(env.root, DOWNLOADS_DIR);
      await mkdir(downloads, { recursive: true });
      await cleanDownloads(env, downloads, zip);
      let unpacked: Unpacked | null = null;
      try {
        unpacked = await unpack(env, zip, null, run);
        const release = await checkPackage(env, unpacked.packageDir, unpacked.version);
        const downgrade = (compareVersions(release.version, env.own.version) ?? 0) < 0;
        const restore = downgrade ? await downgradeOf(env.home, env.own, release) : null;
        if (restore?.needsRestore === true && restore.backupAt === null) {
          fail(makeError('UPDATE_DOWNGRADE_BLOCKED', { version: release.version }));
        }
        const staged = await stage(env, unpacked.packageDir, run);
        await cleanup(env, release.version);
        return {
          ...staged,
          downgrade,
          needsRestore: restore?.needsRestore ?? false,
          backupAt: restore?.backupAt ?? null,
        };
      } finally {
        if (unpacked !== null) await removeQuietly(unpacked.dir, env.log);
      }
    });
  } finally {
    await removeQuietly(zip, env.log);
  }
}

/** UPDATE_DOWNLOAD_FAILED for a failed zip download (`reason` network, timeout, http + status, size, disk). */
export function downloadFailedPayload(error: FetchError): ErrorPayload {
  switch (error.reason) {
    case 'http':
      return makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'http', status: error.status });
    case 'timeout':
    case 'disk':
      return makeError('UPDATE_DOWNLOAD_FAILED', { reason: error.reason });
    case 'too_large':
      return makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'size' });
    case 'network':
    case 'url':
    case 'aborted':
      return makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'network' });
  }
}

/**
 * The update code of a failed preparation (WP-87 §2.1 "Fehler beim Vorbereiten"): InstallError
 * `signature` → UPDATE_INVALID_SIGNATURE {file: 'release.json'}, `node` → UPDATE_NODE_TOO_OLD,
 * `files` → UPDATE_INVALID_PACKAGE {reason: 'files'}, `sdk` (also SdkError) → UPDATE_SDK_FAILED,
 * `in_use`/`io` and anything unknown → UPDATE_DOWNLOAD_FAILED {reason: 'disk'}.
 */
export function prepareErrorPayload(error: unknown, nodeVersion: string): ErrorPayload {
  if (error instanceof CommandError) return error.error;
  if (error instanceof ZipError) return makeError('UPDATE_INVALID_PACKAGE', { reason: error.reason });
  if (error instanceof FetchError) return downloadFailedPayload(error);
  switch (installErrorReason(error)) {
    case 'signature':
      return makeError('UPDATE_INVALID_SIGNATURE', { file: 'release.json' });
    case 'node':
      return makeError('UPDATE_NODE_TOO_OLD', { required: null, actual: nodeVersion });
    case 'files':
      return makeError('UPDATE_INVALID_PACKAGE', { reason: 'files' });
    case 'sdk':
      return makeError('UPDATE_SDK_FAILED');
    case 'in_use':
    case 'io':
      return makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'disk' });
  }
}
