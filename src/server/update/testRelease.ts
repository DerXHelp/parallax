/**
 * Test support (WP-87a, imported only by tests): a fake release server behind an injected `fetch`
 * (no network), signed `latest.json`, and release zips made with `System32\tar.exe` from a test
 * package in a temp folder of the test environment (like WP-86; install/testPackage.ts).
 *
 * Linux (WP-108): the archive of this host is a tar.gz made with `/usr/bin/tar` (`archiveFolders`);
 * `serveRelease` lists it in `assets` like scripts/release/sign.ts.
 */
import { createHash, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runFile, systemTool } from '../lib/process';
import type { TestKey } from '../install/testPackage';
import {
  archiveFormatOf,
  releaseAssetName,
  releaseTarget,
  testEndpoints,
  type ReleaseTarget,
  type UpdateEndpoints,
} from './endpoints';
import { latestForTarget, type LatestInfo } from './latest';

/** Base of the fake releases (loopback: `testEndpoints` allows it; nothing is ever connected). */
export const TEST_RELEASES = 'http://127.0.0.1:9/releases';

export function testUpdateEndpoints(keys: readonly string[]): UpdateEndpoints {
  return testEndpoints({
    PARALLAX_TEST_UPDATE_BASE: TEST_RELEASES,
    PARALLAX_TEST_RELEASE_KEYS: keys.join(','),
  });
}

export function signBytes(bytes: Uint8Array, key: TestKey): string {
  return `${sign(null, bytes, key.privateKey).toString('base64')}\n`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that answers from a route table (exact URL) and records every request. */
export class FakeReleaseServer {
  readonly routes = new Map<string, Handler>();
  readonly calls: { url: string; init: RequestInit | undefined }[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, init });
    const handler = this.routes.get(url);
    if (handler === undefined) return new Response('not found', { status: 404 });
    return handler(init);
  };

  /** A fixed answer (bytes or text, status 200 unless given). */
  set(url: string, body: Uint8Array | string, init: ResponseInit = {}): void {
    this.routes.set(url, () => new Response(typeof body === 'string' ? body : Buffer.from(body), init));
  }

  /** Requests to `url` so far. */
  count(url: string): number {
    return this.calls.filter((call) => call.url === url).length;
  }
}

/** A fetch answer that never comes – until the request's signal aborts. */
export function hangingResponse(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });
}

export interface ReleaseFiles {
  /** As `checkLatest` hands it on: url, size and hash of the asset of this host. */
  latest: LatestInfo;
  /** The served latest.json. */
  bytes: Buffer;
}

/**
 * latest.json of `version` for the archive bytes `zip` (the asset of `endpoints.target`), signed
 * with `key` and served with archive and changelog. The top level names the Windows zip like
 * sign.ts; `latest` overrides url, size and hash of the host's asset as well.
 */
export function serveRelease(
  server: FakeReleaseServer,
  endpoints: UpdateEndpoints,
  key: TestKey,
  release: { version: string; zip: Buffer; changelog?: string; notes?: string; latest?: Partial<LatestInfo> },
): ReleaseFiles {
  const target = endpoints.target ?? 'win';
  const overrides = release.latest ?? {};
  const changelog =
    release.changelog ?? `# Changelog\n\n## [${release.version}] – 2026-11-28\n\n### Neu\n\n- Test.\n`;
  const asset = {
    name: releaseAssetName(release.version, target),
    url: overrides.url ?? endpoints.assetUrl(release.version, target),
    size: overrides.size ?? release.zip.length,
    sha256: overrides.sha256 ?? sha256(release.zip),
  };
  const served: LatestInfo = {
    schemaVersion: 1,
    version: release.version,
    prerelease: release.version.includes('-'),
    minNode: '26.9.0',
    url: target === 'win' ? asset.url : endpoints.assetUrl(release.version, 'win'),
    size: asset.size,
    sha256: asset.sha256,
    changelogSha256: sha256(changelog),
    notes: release.notes ?? '### Neu\n\n- Test.',
    createdAt: '2026-11-28T10:00:00.000Z',
    assets: [asset],
    ...overrides,
  };
  const bytes = Buffer.from(`${JSON.stringify(served, null, 2)}\n`, 'utf8');
  server.set(endpoints.latestUrl, bytes);
  server.set(endpoints.latestSignatureUrl, signBytes(bytes, key));
  server.set(endpoints.assetUrl(release.version, target), release.zip);
  server.set(endpoints.changelogUrl(release.version), changelog);
  return { latest: latestForTarget(served, target) ?? served, bytes };
}

/** `tar.exe -a -c -f <zip> -C <parent> <folders…>` (like the release CI); returns the zip bytes. */
export async function zipFolders(parent: string, folders: readonly string[], zip: string): Promise<Buffer> {
  const result = await runFile(systemTool('tar.exe'), ['-a', '-c', '-f', zip, '-C', parent, ...folders], {
    cwd: parent,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`tar.exe failed: ${result.stderr}`);
  return readFile(zip);
}

/**
 * The release archive of `target` (default: this host): the zip with tar.exe (Windows), a tar.gz
 * with the system tar (`tar -c -z`, Linux). Returns the bytes.
 */
export async function archiveFolders(
  parent: string,
  folders: readonly string[],
  file: string,
  target: ReleaseTarget = releaseTarget() ?? 'win',
): Promise<Buffer> {
  if (archiveFormatOf(target) === 'zip') return zipFolders(parent, folders, file);
  const result = await runFile(systemTool('tar'), ['-c', '-z', '-f', file, '-C', parent, ...folders], {
    cwd: parent,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr}`);
  return readFile(file);
}

/** Path of a zip next to `parent` named like a release asset. */
export function zipPath(parent: string, version: string): string {
  return path.join(parent, `parallax-${version}-win.zip`);
}

/** Path of the archive of `target` (default: this host) in `parent`, named like the release asset. */
export function archivePath(
  parent: string,
  version: string,
  target: ReleaseTarget = releaseTarget() ?? 'win',
): string {
  return path.join(parent, releaseAssetName(version, target));
}
