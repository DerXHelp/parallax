import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_IDLE_TIMEOUT_MS,
  FetchError,
  METADATA_TIMEOUT_MS,
  downloadFile,
  fetchBytes,
  isAllowedUpdateUrl,
} from './fetch';
import { FakeReleaseServer, hangingResponse, sha256 } from './testRelease';

const temps: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-fetch-'));
  temps.push(dir);
  return dir;
}

const A = 'https://github.example/o/r/releases/latest/download/latest.json';
const B = 'https://objects.example/asset?sig=secret';

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof FetchError)) throw new Error(`expected a FetchError, got ${String(error)}`);
  return error;
}

describe('isAllowedUpdateUrl', () => {
  it('allows https, loopback http only in a test build, never user info', () => {
    expect(isAllowedUpdateUrl(new URL('https://github.com/x'), false)).toBe(true);
    expect(isAllowedUpdateUrl(new URL('http://github.com/x'), true)).toBe(false);
    expect(isAllowedUpdateUrl(new URL('http://127.0.0.1:9/x'), false)).toBe(false);
    expect(isAllowedUpdateUrl(new URL('http://127.0.0.1:9/x'), true)).toBe(true);
    expect(isAllowedUpdateUrl(new URL('https://user:pw@github.example/x'), false)).toBe(false);
    expect(isAllowedUpdateUrl(new URL('file:///C:/x'), true)).toBe(false);
  });
});

describe('fetchBytes', () => {
  it('follows redirects by hand without credentials', async () => {
    const server = new FakeReleaseServer();
    server.routes.set(A, () => redirect(B));
    server.set(B, 'hello');
    const bytes = await fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 100 });
    expect(bytes.toString('utf8')).toBe('hello');
    expect(server.calls.map((call) => call.url)).toEqual([A, B]);
    for (const call of server.calls) {
      expect(call.init?.redirect).toBe('manual');
      expect(call.init?.credentials).toBe('omit');
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/authorization|cookie/iu);
    }
  });

  it('refuses an http hop, too many hops and an invalid location', async () => {
    const server = new FakeReleaseServer();
    server.routes.set(A, () => redirect('http://objects.example/asset'));
    expect(
      (await failure(fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 10 }))).reason,
    ).toBe('url');

    const loop = new FakeReleaseServer();
    for (let i = 0; i < 7; i++)
      loop.routes.set(`https://h.example/${String(i)}`, () => redirect(`/${String(i + 1)}`));
    const error = await failure(
      fetchBytes('https://h.example/0', { fetch: loop.fetch, allowLoopbackHttp: false, maxBytes: 10 }),
    );
    expect(error.reason).toBe('url');
    expect(loop.calls).toHaveLength(6); // the start and five redirects

    const broken = new FakeReleaseServer();
    broken.routes.set(A, () => new Response(null, { status: 301 }));
    const missing = await failure(
      fetchBytes(A, { fetch: broken.fetch, allowLoopbackHttp: false, maxBytes: 10 }),
    );
    expect(missing.reason).toBe('http');
    expect(missing.status).toBe(301);
  });

  it('maps HTTP errors with their status and network failures', async () => {
    const server = new FakeReleaseServer();
    const notFound = await failure(
      fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 10 }),
    );
    expect([notFound.reason, notFound.status]).toEqual(['http', 404]);

    const down: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('ENOTFOUND') }));
    const network = await failure(fetchBytes(A, { fetch: down, allowLoopbackHttp: false, maxBytes: 10 }));
    expect(network.reason).toBe('network');
    expect(network.message).toContain('ENOTFOUND');
  });

  it('enforces the size limit by content-length and while reading', async () => {
    const server = new FakeReleaseServer();
    server.set(A, 'x'.repeat(20), { headers: { 'content-length': '20' } });
    expect(
      (await failure(fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 10 }))).reason,
    ).toBe('too_large');
    server.routes.set(
      A,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.enqueue(new Uint8Array(8));
              controller.close();
            },
          }),
        ),
    );
    expect(
      (await failure(fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 10 }))).reason,
    ).toBe('too_large');
  });

  it('times out after 30 s and reports an abort of the caller', async () => {
    vi.useFakeTimers();
    const server = new FakeReleaseServer();
    server.routes.set(A, hangingResponse);
    const pending = failure(fetchBytes(A, { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 10 }));
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS);
    expect((await pending).reason).toBe('timeout');

    const controller = new AbortController();
    const aborted = failure(
      fetchBytes(A, {
        fetch: server.fetch,
        allowLoopbackHttp: false,
        maxBytes: 10,
        signal: controller.signal,
      }),
    );
    controller.abort();
    expect((await aborted).reason).toBe('aborted');
  });
});

describe('downloadFile', () => {
  it('streams into the file with SHA-256 and progress', async () => {
    const dir = await temp();
    const file = path.join(dir, 'x.zip.partial');
    const server = new FakeReleaseServer();
    const data = Buffer.from('zip content '.repeat(1000));
    server.set(B, data);
    const progress: number[] = [];
    const result = await downloadFile(B, file, {
      fetch: server.fetch,
      allowLoopbackHttp: false,
      maxBytes: data.length,
      expected: data.length,
      onProgress: (done, total) => {
        expect(total).toBe(data.length);
        progress.push(done);
      },
    });
    expect(result).toEqual({ bytes: data.length, sha256: sha256(data) });
    expect(await readFile(file)).toEqual(data);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(data.length);
  });

  it('stops a body larger than expected and an idle stream', async () => {
    const dir = await temp();
    const server = new FakeReleaseServer();
    server.set(B, Buffer.alloc(100));
    const large = await failure(
      downloadFile(B, path.join(dir, 'a'), {
        fetch: server.fetch,
        allowLoopbackHttp: false,
        maxBytes: 1000,
        expected: 50,
      }),
    );
    expect(large.reason).toBe('too_large');

    vi.useFakeTimers();
    server.routes.set(
      B,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
            },
          }),
        ),
    );
    const idle = failure(
      downloadFile(B, path.join(dir, 'b'), { fetch: server.fetch, allowLoopbackHttp: false, maxBytes: 1000 }),
    );
    await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_TIMEOUT_MS + 10);
    expect((await idle).reason).toBe('timeout');
  });

  it('reports a write failure as disk', async () => {
    const dir = await temp();
    const server = new FakeReleaseServer();
    server.set(B, 'data');
    const error = await failure(
      downloadFile(B, path.join(dir, 'missing', 'folder', 'x'), {
        fetch: server.fetch,
        allowLoopbackHttp: false,
        maxBytes: 100,
      }),
    );
    expect(error.reason).toBe('disk');
  });
});
