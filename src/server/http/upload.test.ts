import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { attachmentUploadResponseSchema, authCookieName } from '@shared/http';
import { blobRefSchema } from '@shared/model';
import { createServerInstance } from '../config';
import { blobMetaPath, createBlobStore, type FileBlobStore } from '../store/blobs';
import { createApp } from './app';
import { createAuthService } from './auth';
import { makeTempHome } from './testServer';

const PORT = 4711;
const HOST = '127.0.0.1:4711';
const ORIGIN = 'http://127.0.0.1:4711';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-test'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test')]);
const GIF = Buffer.from('GIF89a-test');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 x')]);

interface Fixture {
  app: FastifyInstance;
  blobs: FileBlobStore;
  home: string;
  headers: Record<string, string>;
}

let fixture: Fixture | null = null;

afterEach(async () => {
  await fixture?.app.close();
  await fixture?.blobs.close();
  fixture = null;
});

async function setup(): Promise<Fixture> {
  const home = await makeTempHome('upload-');
  const instance = createServerInstance({ serverVersion: '1.2.3' });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const app = await createApp({ config: { port: PORT, dev: false }, instance, auth, blobs, webRoot: null });
  fixture = {
    app,
    blobs,
    home,
    headers: {
      host: HOST,
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      cookie: `${authCookieName(PORT)}=${auth.createCookieValue()}`,
    },
  };
  return fixture;
}

function upload(f: Fixture, body: Buffer, type: string, query = '', headers: Record<string, string> = {}) {
  return f.app.inject({
    method: 'POST',
    url: `/api/attachments${query}`,
    headers: { ...f.headers, 'content-type': type, ...headers },
    payload: body,
  });
}

describe('POST /api/attachments (ADR-103)', () => {
  it('stores a PNG as a blob with name and pixel size and answers its BlobRef', async () => {
    const f = await setup();
    const res = await upload(f, PNG, 'image/png', '?name=screen%20shot.png&width=1568&height=882');
    expect(res.statusCode).toBe(200);
    const { attachment } = attachmentUploadResponseSchema.parse(res.json());
    expect(attachment).toEqual({
      blobId: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      width: 1568,
      height: 882,
      name: 'screen shot.png',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    // Served like any blob; the meta file carries width/height.
    const stored = await f.blobs.get(attachment.blobId);
    expect(Buffer.from(stored?.data ?? new Uint8Array()).equals(PNG)).toBe(true);
    await f.blobs.flush();
    const meta = blobRefSchema.parse(
      JSON.parse(await readFile(blobMetaPath(f.home, attachment.blobId), 'utf8')),
    );
    expect(meta).toMatchObject({ width: 1568, height: 882, name: 'screen shot.png' });
  });

  it.each([
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['image/png; charset=binary', PNG],
  ])('accepts %s without a query (size and name null)', async (type, body) => {
    const f = await setup();
    const res = await upload(f, body, type);
    expect(res.statusCode).toBe(200);
    expect(attachmentUploadResponseSchema.parse(res.json()).attachment).toMatchObject({
      mediaType: type.split(';')[0],
      width: null,
      height: null,
      name: null,
    });
  });

  it('413 PAYLOAD_TOO_LARGE above LIMITS.imageBytes', async () => {
    const f = await setup();
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes)]);
    const res = await upload(f, big, 'image/png');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    // Exactly at the limit is fine.
    const atLimit = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes - PNG.byteLength)]);
    expect((await upload(f, atLimit, 'image/png')).statusCode).toBe(200);
  });

  it.each([
    ['text/plain', PNG],
    ['image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')],
    ['application/octet-stream', PNG],
    ['multipart/form-data; boundary=x', PNG],
  ])('415 UNSUPPORTED_MEDIA_TYPE for Content-Type %s', async (type, body) => {
    const f = await setup();
    const res = await upload(f, body, type);
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it.each([
    ['JPEG bytes as PNG (a renamed photo.png)', 'image/png', JPEG, 'image/jpeg'],
    ['PNG bytes as GIF', 'image/gif', PNG, 'image/png'],
    ['WebP bytes as JPEG', 'image/jpeg', WEBP, 'image/webp'],
  ])('CR2-08: %s is stored with the type of its magic bytes (ADR-134)', async (_name, type, body, real) => {
    const f = await setup();
    const res = await upload(f, body, type, '?name=photo.png&width=4&height=3');
    expect(res.statusCode).toBe(200);
    const { attachment } = attachmentUploadResponseSchema.parse(res.json());
    expect(attachment).toMatchObject({ mediaType: real, name: 'photo.png', width: 4, height: 3 });
    // What the prompt check (resolveAttachments) and GET /api/blob see.
    expect((await f.blobs.get(attachment.blobId))?.ref.mediaType).toBe(real);
  });

  it.each([
    ['HTML as PNG', 'image/png', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['SVG as PNG', 'image/png', Buffer.from('<svg onload="alert(1)"/>')],
    ['an empty body', 'image/png', Buffer.alloc(0)],
  ])('415 when the magic bytes show no image type: %s', async (_name, type, body) => {
    const f = await setup();
    const res = await upload(f, body, type);
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it.each(['?width=abc', '?width=0', '?height=-5', `?name=${'x'.repeat(261)}`, '?name=', '?width=100001'])(
    '400 VALIDATION_FAILED for the query %s',
    async (query) => {
      const f = await setup();
      const res = await upload(f, PNG, 'image/png', query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'query' } });
    },
  );

  it('guard "mutation": 401 without the cookie, 403 for a foreign origin or a cross-site request', async () => {
    const f = await setup();
    const noCookie = await upload(f, PNG, 'image/png', '', { cookie: '' });
    expect(noCookie.statusCode).toBe(401);
    expect(noCookie.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    const foreign = await upload(f, PNG, 'image/png', '', { origin: 'http://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'ORIGIN_REJECTED', params: { reason: 'origin' } });
    const crossSite = await upload(f, PNG, 'image/png', '', { 'sec-fetch-site': 'same-site' });
    expect(crossSite.statusCode).toBe(403);
    expect((await upload(f, PNG, 'image/png', '', { 'sec-fetch-site': '' })).statusCode).toBe(403);
  });
});
