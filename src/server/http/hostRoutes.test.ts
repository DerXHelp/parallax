import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError, type ErrorCode } from '@shared/errors';
import {
  BLOB_CSP,
  FILE_PDF_CSP,
  REMOTE_PATHS,
  authCookieName,
  hostAttachmentsPath,
  hostBlobPath,
  hostFileUrl,
  hostWsPath,
  serverOrigin,
} from '@shared/http';
import { WS_CLOSE } from '@shared/protocol';
import { createServerInstance } from '../config';
import type { FileContent, FileContentProvider } from '../files/ports';
import { startControl, startSharing, type ControlSide, type SharingSide } from '../hosts/testKit';
import { createBlobStore, blobFilePath, type FileBlobStore } from '../store/blobs';
import { CommandError } from '../sync/ports';
import { createApp } from './app';
import { createAuthService, type AuthService } from './auth';
import { registerContentRoutes } from './content';
import { connectWs, cookieFromSetCookie, makeTempHome, rawRequest, type TestWsClient } from './testServer';

const ENTRY = 'en_00000000000000000000000000000001';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PDF = Buffer.from('%PDF-1.4\n% test\n');

function content(data: Buffer, mediaType: string, name: string, policy: FileContent['policy']): FileContent {
  return { stream: Readable.from([data]), mediaType, bytes: data.length, name, policy };
}

function fakeFiles(opened: string[]): FileContentProvider {
  return {
    open: (entryId, file) => {
      opened.push(`${entryId} ${file}`);
      const failure = /^C:\\err\\([A-Z_]+)$/u.exec(file)?.[1];
      if (failure !== undefined) {
        return Promise.reject(
          new CommandError(makeError(failure as ErrorCode, { path: file, extra: 'x'.repeat(500) })),
        );
      }
      switch (file) {
        case 'C:\\p\\a.txt':
          return Promise.resolve(
            content(Buffer.from('hello\n'), 'text/plain; charset=utf-8', 'a.txt', 'blob'),
          );
        case 'C:\\p\\doc.pdf':
          return Promise.resolve(content(PDF, 'application/pdf', 'doc.pdf', 'pdf'));
        // the other side claims a PDF that is none: this server decides by the bytes
        case 'C:\\p\\fake.pdf':
          return Promise.resolve(content(Buffer.from('<html>'), 'application/pdf', 'fake.pdf', 'pdf'));
        case 'C:\\p\\page.html':
          return Promise.resolve(
            content(Buffer.from('<script>1</script>'), 'text/html', 'page.html', 'blob'),
          );
        default:
          return Promise.reject(new CommandError(makeError('FILE_NOT_FOUND')));
      }
    },
  };
}

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body arrived whole (false: the transfer was cut). */
  complete: boolean;
}

function send(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: Buffer },
): Promise<Response> {
  // like fetch() with a Blob body: the length is announced
  const headers = {
    ...(options.body === undefined ? {} : { 'content-length': String(options.body.length) }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method, path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', () => undefined);
        res.on('close', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            complete: res.complete,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface Setup {
  port: number;
  origin: string;
  cookie: string;
  auth: AuthService;
  sharing: SharingSide;
  control: ControlSide;
  hostId: string;
  remoteHome: string;
  remoteBlobs: FileBlobStore;
  opened: string[];
  /** Same-origin headers of the app's own page (+ cookie). */
  page(extra?: Record<string, string>): Record<string, string>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<Setup> {
  const remoteHome = await makeTempHome('wp79-remote-');
  const remoteBlobs = createBlobStore({ home: remoteHome });
  const opened: string[] = [];
  const sharing = await startSharing({
    registerContent: (peerApp, context) =>
      registerContentRoutes(peerApp, {
        paths: REMOTE_PATHS,
        blobs: remoteBlobs,
        files: fakeFiles(opened),
        beforeEffect: (request) => context.isCurrent(request),
      }),
  });
  cleanups.push(async () => {
    await sharing.close();
    await remoteBlobs.close();
  });
  const control = await startControl();
  cleanups.push(() => control.close());
  const hostId = await control.add(sharing);
  await control.waitFor(hostId, 'connected');

  const home = await makeTempHome('wp79-app-');
  const instance = createServerInstance({ serverVersion: control.version });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const app = await createApp({
    config: { port: 0, dev: false },
    instance,
    auth,
    blobs,
    hosts: control.service,
    webRoot: null,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => {
    await app.close();
    await blobs.close();
    await auth.close();
  });
  const address = app.server.address();
  if (address === null || typeof address !== 'object') throw new Error('not listening');
  const port = address.port;
  const origin = serverOrigin(port);
  const { code } = auth.issueAuthCode();
  const login = await rawRequest(port, {
    method: 'POST',
    path: '/api/auth',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const cookie = cookieFromSetCookie(login.headers['set-cookie'], authCookieName(port));
  if (cookie === null) throw new Error('login failed');
  return {
    port,
    origin,
    cookie,
    auth,
    sharing,
    control,
    hostId,
    remoteHome,
    remoteBlobs,
    opened,
    page: (extra = {}) => ({ origin, 'sec-fetch-site': 'same-origin', cookie, ...extra }),
  };
}

async function window(s: Setup, hostId = s.hostId): Promise<TestWsClient> {
  const result = await connectWs(
    { port: s.port, origin: s.origin, host: `127.0.0.1:${String(s.port)}` },
    { cookie: s.cookie, path: hostWsPath(hostId) },
  );
  if (!result.ok) throw new Error(`upgrade refused: ${String(result.status)} ${result.body}`);
  return result.client;
}

function json(response: Response): unknown {
  return JSON.parse(response.body.toString('utf8'));
}

describe('forwarder routes: guard (§B.12)', () => {
  it('foreign Origin, wrong Host and a missing cookie are refused before anything is forwarded', async () => {
    const s = await setup();
    const blob = s.remoteBlobs.put(PNG, 'image/png', null, null);
    const path = hostBlobPath(s.hostId, blob.blobId);
    const file = hostFileUrl(s.hostId, ENTRY, 'C:\\p\\a.txt');
    const cases: [string, string, Record<string, string>, number, string][] = [
      ['GET', path, s.page({ origin: 'https://evil.example' }), 403, 'ORIGIN_REJECTED'],
      ['GET', path, s.page({ host: '192.0.2.7' }), 403, 'HOST_HEADER_REJECTED'],
      ['GET', path, { origin: s.origin }, 401, 'AUTH_REQUIRED'],
      ['GET', file, s.page({ 'sec-fetch-site': 'cross-site' }), 403, 'ORIGIN_REJECTED'],
      // file: only the app's own pages (Sec-Fetch-Site same-origin required, ADR-142)
      ['GET', file, { cookie: s.cookie }, 403, 'ORIGIN_REJECTED'],
      [
        'POST',
        hostAttachmentsPath(s.hostId),
        { cookie: s.cookie, 'content-type': 'image/png' },
        403,
        'ORIGIN_REJECTED',
      ],
    ];
    for (const [method, target, headers, status, code] of cases) {
      const response = await send(s.port, {
        method,
        path: target,
        headers,
        ...(method === 'POST' ? { body: PNG } : {}),
      });
      expect([target, response.status, (json(response) as { code: string }).code]).toEqual([
        target,
        status,
        code,
      ]);
    }
    expect(s.opened).toEqual([]);

    const upgrades: [Parameters<typeof connectWs>[1], number][] = [
      [{ cookie: s.cookie, origin: 'https://evil.example' }, 403],
      [{ cookie: s.cookie, host: '192.0.2.7' }, 403],
      [{ cookie: s.cookie, origin: null }, 403],
      [{}, 401],
    ];
    for (const [options, status] of upgrades) {
      const result = await connectWs(
        { port: s.port, origin: s.origin, host: `127.0.0.1:${String(s.port)}` },
        { ...options, path: hostWsPath(s.hostId) },
      );
      expect(result.ok ? 101 : result.status).toBe(status);
    }
    expect(s.control.service.windowCount(s.hostId)).toBe(0);
  });

  it('an unknown hostId → HOST_NOT_FOUND on every route', async () => {
    const s = await setup();
    const blobId = 'a'.repeat(64);
    for (const [method, target] of [
      ['GET', hostBlobPath('pc-z', blobId)],
      ['GET', hostFileUrl('pc-z', ENTRY, 'C:\\p\\a.txt')],
      ['POST', hostAttachmentsPath('pc-z')],
    ] as const) {
      const response = await send(s.port, {
        method,
        path: target,
        headers: s.page({ 'content-type': 'image/png' }),
        ...(method === 'POST' ? { body: PNG } : {}),
      });
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ code: 'HOST_NOT_FOUND', params: {} });
    }
    const upgrade = await connectWs(
      { port: s.port, origin: s.origin, host: `127.0.0.1:${String(s.port)}` },
      { cookie: s.cookie, path: hostWsPath('pc-z') },
    );
    expect(upgrade.ok ? 101 : upgrade.status).toBe(404);
  });
});

describe('forwarder routes: window connections', () => {
  it('passes frames 1:1 to the hub of the other computer and back', async () => {
    const s = await setup();
    const client = await window(s);
    const hello = await client.next('hello');
    expect(hello.serverVersion).toBe(s.sharing.version);
    client.send({
      type: 'clientHello',
      protocolVersion: hello.protocolVersion,
      buildId: 'test',
      clientId: 'cl_00000000000000000000000000000009',
      presence: { focused: true, visible: true, viewingEntryId: null, typing: false },
      kind: 'window',
    });
    // the other computer's hub answers (and redacts its remote access for a remote connection)
    const state = await client.next('host.state');
    expect(state.host.remoteAccess).toBeNull();
    await expect
      .poll(() =>
        (s.sharing.source.presenceUpdates.at(-1) ?? []).some(
          (entry) => entry.clientId === 'cl_00000000000000000000000000000009' && entry.origin === 'remote',
        ),
      )
      .toBe(true);
    expect(s.control.service.windowCount(s.hostId)).toBe(1);
    await client.close();
    await expect.poll(() => s.control.service.windowCount(s.hostId)).toBe(0);
  });

  it('coupling revoked over there → the browser window closes with HOST_REVOKED', async () => {
    const s = await setup();
    const client = await window(s);
    await client.next('hello');
    await s.sharing.harness.command({ name: 'remoteAccess.unpair' });
    expect((await client.closed).code).toBe(WS_CLOSE.HOST_REVOKED);
    // a new window is refused at once (the computer is revoked)
    await s.control.waitFor(s.hostId, 'revoked');
    const again = await window(s);
    expect((await again.closed).code).toBe(WS_CLOSE.HOST_REVOKED);
  });

  it('the other side going away → HOST_UNREACHABLE; signing the device out → AUTH_REVOKED', async () => {
    const s = await setup();
    const first = await window(s);
    await first.next('hello');
    const second = await window(s);
    await second.next('hello');
    await s.auth.rotateSecret();
    expect((await second.closed).code).toBe(WS_CLOSE.AUTH_REVOKED);
    expect((await first.closed).code).toBe(WS_CLOSE.AUTH_REVOKED);

    const third = await setup();
    const client = await window(third);
    await client.next('hello');
    await third.sharing.close();
    expect((await client.closed).code).toBe(WS_CLOSE.HOST_UNREACHABLE);
  });
});

describe('forwarder routes: content', () => {
  it('blob: own headers, verified bytes, HEAD, unknown blob passes as BLOB_NOT_FOUND', async () => {
    const s = await setup();
    const image = s.remoteBlobs.put(PNG, 'image/png', null, null);
    const pdf = s.remoteBlobs.put(PDF, 'application/pdf', 'doc.pdf', null);
    await s.remoteBlobs.flush();

    const got = await send(s.port, {
      method: 'GET',
      path: hostBlobPath(s.hostId, image.blobId),
      headers: s.page(),
    });
    expect(got.status).toBe(200);
    expect(got.complete).toBe(true);
    expect(got.body.equals(PNG)).toBe(true);
    expect(got.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'content-security-policy': BLOB_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, max-age=31536000, immutable',
    });

    const doc = await send(s.port, {
      method: 'GET',
      path: hostBlobPath(s.hostId, pdf.blobId),
      headers: s.page(),
    });
    expect(doc.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(doc.headers['x-frame-options']).toBe('SAMEORIGIN');

    const head = await send(s.port, {
      method: 'HEAD',
      path: hostBlobPath(s.hostId, image.blobId),
      headers: s.page(),
    });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-security-policy']).toBe(BLOB_CSP);

    const missing = await send(s.port, {
      method: 'GET',
      path: hostBlobPath(s.hostId, 'c'.repeat(64)),
      headers: s.page(),
    });
    expect(missing.status).toBe(404);
    expect(json(missing)).toEqual({ code: 'BLOB_NOT_FOUND', params: {} });
    const invalid = await send(s.port, {
      method: 'GET',
      path: `/api/hosts/${s.hostId}/blob/zz`,
      headers: s.page(),
    });
    expect(json(invalid)).toEqual({ code: 'BLOB_NOT_FOUND', params: {} });
  });

  it('blob: bytes that do not hash to the id never arrive whole', async () => {
    const s = await setup();
    const image = s.remoteBlobs.put(PNG, 'image/png', null, null);
    await s.remoteBlobs.flush();
    const tampered = Buffer.from(PNG);
    tampered[20] = 0;
    await writeFile(blobFilePath(s.remoteHome, image.blobId), tampered);
    expect(createHash('sha256').update(tampered).digest('hex')).not.toBe(image.blobId);
    // the last chunk is held back until the hash matched: the connection ends without an answer
    const got = await send(s.port, {
      method: 'GET',
      path: hostBlobPath(s.hostId, image.blobId),
      headers: s.page(),
    }).catch(() => null);
    expect(got?.complete ?? false).toBe(false);
    expect(got?.body.equals(tampered) ?? false).toBe(false);
  });

  it('file: rebuilt query, own headers and policy by the bytes, errors only from the allowlist', async () => {
    const s = await setup();
    const text = await send(s.port, {
      method: 'GET',
      path: `${hostFileUrl(s.hostId, ENTRY, 'C:\\p\\a.txt')}&extra=1`,
      headers: s.page(),
    });
    expect(text.status).toBe(200);
    expect(text.body.toString('utf8')).toBe('hello\n');
    expect(text.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': "inline; filename*=UTF-8''a.txt",
      'content-security-policy': BLOB_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(s.opened).toEqual([`${ENTRY} C:\\p\\a.txt`]);

    const pdf = await send(s.port, {
      method: 'GET',
      path: hostFileUrl(s.hostId, ENTRY, 'C:\\p\\doc.pdf'),
      headers: s.page(),
    });
    expect(pdf.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(pdf.body.equals(PDF)).toBe(true);
    const fake = await send(s.port, {
      method: 'GET',
      path: hostFileUrl(s.hostId, ENTRY, 'C:\\p\\fake.pdf'),
      headers: s.page(),
    });
    expect(fake.headers['content-security-policy']).toBe(BLOB_CSP);
    expect(fake.headers['x-frame-options']).toBe('DENY');
    const html = await send(s.port, {
      method: 'GET',
      path: hostFileUrl(s.hostId, ENTRY, 'C:\\p\\page.html'),
      headers: s.page(),
    });
    expect(html.headers['content-security-policy']).toBe(BLOB_CSP);
    expect(html.headers['content-type']).toBe('text/html');

    const notFound = await send(s.port, {
      method: 'GET',
      path: hostFileUrl(s.hostId, ENTRY, 'C:\\err\\FILE_NOT_FOUND'),
      headers: s.page(),
    });
    expect(notFound.status).toBe(404);
    const error = json(notFound) as { code: string; params: Record<string, string> };
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.params.extra?.length).toBe(200);
    // a code outside the allowlist becomes HOST_UNREACHABLE
    const internal = await send(s.port, {
      method: 'GET',
      path: hostFileUrl(s.hostId, ENTRY, 'C:\\err\\INTERNAL_ERROR'),
      headers: s.page(),
    });
    expect(internal.status).toBe(502);
    expect(json(internal)).toEqual({ code: 'HOST_UNREACHABLE', params: { reason: 'status_500' } });

    const opened = s.opened.length;
    const badQuery = await send(s.port, {
      method: 'GET',
      path: `/api/hosts/${s.hostId}/file?entryId=${ENTRY}`,
      headers: s.page(),
    });
    expect(json(badQuery)).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'query' } });
    expect(s.opened.length).toBe(opened);
  });

  it('upload: streamed to the other computer, its answer checked; type and size checked here', async () => {
    const s = await setup();
    // larger than the JSON body limit of the app: the upload has its own limit
    const big = Buffer.concat([PNG, Buffer.alloc(200_000, 1)]);
    const uploaded = await send(s.port, {
      method: 'POST',
      path: `${hostAttachmentsPath(s.hostId)}?width=10&height=20&evil=1`,
      headers: s.page({ 'content-type': 'image/png', 'content-length': String(big.length) }),
      body: big,
    });
    expect(uploaded.status).toBe(200);
    const answer = json(uploaded) as { attachment: { blobId: string; mediaType: string; width?: number } };
    expect(answer.attachment.blobId).toBe(createHash('sha256').update(big).digest('hex'));
    expect(answer.attachment).toMatchObject({ mediaType: 'image/png', width: 10, height: 20 });
    const stored = await s.remoteBlobs.get(answer.attachment.blobId);
    expect(stored?.data.byteLength).toBe(big.length);

    const noName = await send(s.port, {
      method: 'POST',
      path: hostAttachmentsPath(s.hostId),
      headers: s.page({ 'content-type': 'application/octet-stream' }),
      body: Buffer.from('data'),
    });
    expect(json(noName)).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'name' } });

    const wrongType = await send(s.port, {
      method: 'POST',
      path: hostAttachmentsPath(s.hostId),
      headers: s.page({ 'content-type': 'text/html' }),
      body: Buffer.from('<p>'),
    });
    expect(wrongType.status).toBe(415);

    const tooLarge = await send(s.port, {
      method: 'POST',
      path: hostAttachmentsPath(s.hostId),
      headers: s.page({ 'content-type': 'image/png', 'content-length': String(20_000_000) }),
    }).catch(() => null);
    if (tooLarge !== null) expect(tooLarge.status).toBe(413);
  });

  it('after the coupling was revoked, content requests answer HOST_REVOKED', async () => {
    const s = await setup();
    const image = s.remoteBlobs.put(PNG, 'image/png', null, null);
    await s.sharing.harness.command({ name: 'remoteAccess.unpair' });
    await s.control.waitFor(s.hostId, 'revoked');
    const got = await send(s.port, {
      method: 'GET',
      path: hostBlobPath(s.hostId, image.blobId),
      headers: s.page(),
    });
    expect(got.status).toBe(403);
    expect(json(got)).toEqual({ code: 'HOST_REVOKED', params: {} });
  });
});
