import { describe, expect, it } from 'vitest';
import { makeTestKey } from '../install/testPackage';
import { CommandError } from '../sync/ports';
import { checkLatest, latestInfoSchema, type CheckLatestOptions } from './latest';
import { FakeReleaseServer, serveRelease, signBytes, testUpdateEndpoints } from './testRelease';

const key = makeTestKey();
const endpoints = testUpdateEndpoints([key.x]);
const ZIP = Buffer.from('zip bytes');

function options(server: FakeReleaseServer, running = '1.0.0'): CheckLatestOptions {
  return { fetch: server.fetch, allowLoopbackHttp: true, endpoints, running };
}

async function rejection(promise: Promise<unknown>): Promise<CommandError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof CommandError)) throw new Error(`expected a CommandError, got ${String(error)}`);
  return error;
}

describe('checkLatest', () => {
  it('treats a 404 of latest.json as "no update"', async () => {
    const server = new FakeReleaseServer();
    expect(await checkLatest(options(server))).toEqual({ kind: 'none', reason: 'not_found' });
    expect(server.count(endpoints.latestSignatureUrl)).toBe(0);
  });

  it('offers a newer release with its signed changelog', async () => {
    const server = new FakeReleaseServer();
    const changelog = '# Changelog\n\n## [1.0.1] – 2026-11-28\n\n### Behoben\n\n- Fix.\n';
    const { latest } = serveRelease(server, endpoints, key, { version: '1.0.1', zip: ZIP, changelog });
    expect(latestInfoSchema.parse(latest)).toEqual(latest);
    expect(await checkLatest(options(server))).toEqual({ kind: 'available', latest, changelog });
  });

  it('reads minNode (ADR-232); a latest.json written before has none (null)', () => {
    const server = new FakeReleaseServer();
    const { latest } = serveRelease(server, endpoints, key, { version: '1.0.1', zip: ZIP });
    expect(latest.minNode).toBe('26.9.0');
    const { minNode: _minNode, ...older } = latest;
    expect(latestInfoSchema.parse(older).minNode).toBeNull();
    expect(latestInfoSchema.safeParse({ ...latest, minNode: '26.9' }).success).toBe(false);
  });

  it('orders 1.0.0 above 1.0.0-rc.4 (the first full release)', async () => {
    const server = new FakeReleaseServer();
    serveRelease(server, endpoints, key, { version: '1.0.0', zip: ZIP });
    const result = await checkLatest(options(server, '1.0.0-rc.4'));
    expect(result.kind).toBe('available');
  });

  it('never offers an older or the same version, nor a pre-release (downgrade guard)', async () => {
    const server = new FakeReleaseServer();
    serveRelease(server, endpoints, key, { version: '1.0.0', zip: ZIP });
    expect(await checkLatest(options(server, '1.0.0'))).toEqual({ kind: 'none', reason: 'not_newer' });
    expect(await checkLatest(options(server, '1.0.1'))).toEqual({ kind: 'none', reason: 'not_newer' });
    serveRelease(server, endpoints, key, { version: '1.1.0-rc.1', zip: ZIP });
    expect(await checkLatest(options(server))).toEqual({ kind: 'none', reason: 'prerelease' });
    serveRelease(server, endpoints, key, { version: '1.1.0', zip: ZIP, latest: { prerelease: true } });
    expect(await checkLatest(options(server))).toEqual({ kind: 'none', reason: 'prerelease' });
  });

  it('refuses a missing or foreign signature', async () => {
    const server = new FakeReleaseServer();
    const { bytes } = serveRelease(server, endpoints, key, { version: '1.0.1', zip: ZIP });
    server.routes.delete(endpoints.latestSignatureUrl);
    expect((await rejection(checkLatest(options(server)))).error).toEqual({
      code: 'UPDATE_INVALID_SIGNATURE',
      params: { file: 'latest.json' },
    });
    server.set(endpoints.latestSignatureUrl, signBytes(bytes, makeTestKey()));
    expect((await rejection(checkLatest(options(server)))).error.code).toBe('UPDATE_INVALID_SIGNATURE');
    server.set(endpoints.latestSignatureUrl, signBytes(Buffer.concat([bytes, Buffer.from(' ')]), key));
    expect((await rejection(checkLatest(options(server)))).error.code).toBe('UPDATE_INVALID_SIGNATURE');
  });

  it('refuses a foreign asset URL and a broken latest.json even when signed', async () => {
    const server = new FakeReleaseServer();
    serveRelease(server, endpoints, key, {
      version: '1.0.1',
      zip: ZIP,
      latest: { url: 'https://evil.example/parallax-1.0.1-win.zip' },
    });
    expect((await rejection(checkLatest(options(server)))).error).toEqual({
      code: 'UPDATE_CHECK_FAILED',
      params: { reason: 'url' },
    });
    const bytes = Buffer.from('{"schemaVersion":1,"version":"1.0.1"}');
    server.set(endpoints.latestUrl, bytes);
    server.set(endpoints.latestSignatureUrl, signBytes(bytes, key));
    expect((await rejection(checkLatest(options(server)))).error).toEqual({
      code: 'UPDATE_CHECK_FAILED',
      params: { reason: 'schema' },
    });
  });

  it('maps failed requests to UPDATE_CHECK_FAILED', async () => {
    const server = new FakeReleaseServer();
    server.set(endpoints.latestUrl, 'oops', { status: 500 });
    expect((await rejection(checkLatest(options(server)))).error).toEqual({
      code: 'UPDATE_CHECK_FAILED',
      params: { reason: 'http', status: 500 },
    });
    server.set(endpoints.latestUrl, 'x'.repeat(300 * 1024));
    expect((await rejection(checkLatest(options(server)))).error.params).toEqual({ reason: 'too_large' });
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const error = await rejection(checkLatest({ ...options(server), fetch: down }));
    expect(error.error.params).toEqual({ reason: 'network' });
  });

  it('falls back to the notes when the changelog does not match latest.json', async () => {
    const server = new FakeReleaseServer();
    const { latest } = serveRelease(server, endpoints, key, { version: '1.0.1', zip: ZIP });
    server.set(endpoints.changelogUrl('1.0.1'), '# Changelog\n\nmanipulated\n');
    const lines: string[] = [];
    const result = await checkLatest({ ...options(server), log: (line) => lines.push(line) });
    expect(result).toEqual({ kind: 'available', latest, changelog: null });
    expect(lines.join('\n')).toContain('changelogSha256');
    server.routes.delete(endpoints.changelogUrl('1.0.1'));
    expect(await checkLatest(options(server))).toEqual({ kind: 'available', latest, changelog: null });
  });
});
