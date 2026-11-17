/**
 * Update E2E (WP-89e): a local release server on 127.0.0.1 – what GitHub serves for the update
 * (`<base>/latest/download/latest.json` + `.sig` or 404, `<base>/download/v<v>/parallax-<v>-win.zip`,
 * `<base>/download/v<v>/CHANGELOG.md`) and a fake npm registry for the Agent SDK
 * (`<registry>/@anthropic-ai%2Fclaude-agent-sdk` → metadata, the tarball). The test build of the
 * server reads it from `PARALLAX_TEST_UPDATE_BASE` / `PARALLAX_TEST_REGISTRY`; what `latest`
 * offers is switched per test (`offer`). Every request is recorded.
 */
import { createServer, type Server } from 'node:http';
import { AGENT_SDK_PACKAGE } from '../../src/server/launcher/release';
import type { TestKey } from '../../src/server/install/testPackage';
import { CHANGELOG_ASSET, LATEST_FILE, releaseZipName } from '../../src/server/update/endpoints';
import type { LatestInfo } from '../../src/server/update/latest';
import { sha256, signBytes } from '../../src/server/update/testRelease';
import type { MiniSdk } from './update-packages';

export interface OfferedRelease {
  version: string;
  zip: Buffer;
  changelog: string;
  notes: string;
}

export interface ReleaseServer {
  /** `http://127.0.0.1:<port>/releases` (PARALLAX_TEST_UPDATE_BASE). */
  readonly base: string;
  /** `http://127.0.0.1:<port>/registry/` (PARALLAX_TEST_REGISTRY). */
  readonly registry: string;
  /** What `latest/download/latest.json` offers from now on; null = 404 (no full release). */
  offer(release: OfferedRelease | null): LatestInfo | null;
  /** Paths requested so far (without host). */
  readonly requests: string[];
  close(): Promise<void>;
}

interface Route {
  status: number;
  body: Buffer;
  type: string;
}

export async function startReleaseServer(key: TestKey, sdk: MiniSdk): Promise<ReleaseServer> {
  const routes = new Map<string, Route>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    requests.push(url);
    const route = request.method === 'GET' ? routes.get(url) : undefined;
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(route.status, { 'content-type': route.type, 'content-length': route.body.length });
    response.end(route.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('release server: no TCP address');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const base = `${origin}/releases`;
  const registry = `${origin}/registry/`;
  const set = (pathname: string, body: Buffer | string, type: string): void => {
    routes.set(pathname, {
      status: 200,
      body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
      type,
    });
  };

  // The registry: metadata of the one SDK version and its tarball.
  const tarballPath = `/registry/sdk/${AGENT_SDK_PACKAGE.replace('/', '-').replace(/^@/u, '')}-${sdk.spec.version}.tgz`;
  set(tarballPath, sdk.bytes, 'application/octet-stream');
  set(
    `/registry/${AGENT_SDK_PACKAGE.replace('/', '%2F')}`,
    JSON.stringify({
      name: AGENT_SDK_PACKAGE,
      versions: {
        [sdk.spec.version]: {
          name: AGENT_SDK_PACKAGE,
          version: sdk.spec.version,
          dist: { tarball: `${origin}${tarballPath}`, integrity: sdk.spec.integrity },
        },
      },
    }),
    'application/json',
  );

  const latestPath = `/releases/latest/download/${LATEST_FILE}`;
  return {
    base,
    registry,
    requests,
    offer(release) {
      routes.delete(latestPath);
      routes.delete(`${latestPath}.sig`);
      if (release === null) return null;
      const latest: LatestInfo = {
        schemaVersion: 1,
        version: release.version,
        prerelease: release.version.includes('-'),
        url: `${base}/download/v${release.version}/${releaseZipName(release.version)}`,
        size: release.zip.length,
        sha256: sha256(release.zip),
        changelogSha256: sha256(release.changelog),
        notes: release.notes,
        createdAt: new Date().toISOString(),
      };
      const bytes = Buffer.from(`${JSON.stringify(latest, null, 2)}\n`, 'utf8');
      set(latestPath, bytes, 'application/json');
      set(`${latestPath}.sig`, signBytes(bytes, key), 'text/plain');
      set(
        `/releases/download/v${release.version}/${releaseZipName(release.version)}`,
        release.zip,
        'application/zip',
      );
      set(`/releases/download/v${release.version}/${CHANGELOG_ASSET}`, release.changelog, 'text/markdown');
      return latest;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
